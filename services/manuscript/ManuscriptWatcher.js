// Watches the story root and tells open editors when a chapter changes on disk.
//
// The stale-write check in ManuscriptService is the safety net: it refuses a
// save made against a file that moved underneath. This is the courtesy — it
// says so at the moment it happens, instead of an hour later when the writer
// finally presses Save and loses the round trip.
//
// It never decides anything. The server reports what changed and the editor
// decides what to do with it, because only the editor knows whether there is
// unsaved text on screen. Replacing a buffer from a filesystem event would be
// exactly the data loss this whole layer exists to prevent.
//
// STAYING ALIVE is most of this file, because fs.watch does not.
//
//   1. An error used to be fatal. The handler closed the watcher and nothing
//      ever reopened it, so a single blip killed live updates until the server
//      was restarted — silently, since the editor has no way to tell "nothing
//      changed" from "nobody is listening".
//   2. Worse, a recursive watch on Windows can stop delivering events WITHOUT
//      erroring at all, typically after the machine sleeps. There is no event
//      to hook, so sleep is inferred instead: a timer that should fire every
//      30 seconds and comes back minutes late means the machine was suspended,
//      and the watcher is rebuilt on the assumption it did not survive.
//
// Rebuilding is cheap — one fs.watch call — so both paths simply re-arm rather
// than trying to work out whether the old handle is still good.

const fs = require('fs');
const path = require('path');

const Storage = require('../StorageService');
const ManuscriptService = require('./ManuscriptService');

// Windows fires several events for one save — fs.watch reports the rename and
// the size change separately, and the atomic temp+rename adds more. Coalesce.
const DEBOUNCE_MS = 200;

/** How often to check that we are still awake and still watching. */
const HEALTH_MS = 30 * 1000;

/**
 * A health tick this late means the process was not running — the machine
 * slept, or was hard-paused. Generous enough that ordinary event-loop
 * congestion never trips it.
 */
const SLEEP_GAP_MS = 90 * 1000;

/** Backoff after a watch error, so a permanently bad root does not spin. */
const RETRY_MIN_MS = 5 * 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;

let watcher = null;
let watchedRoot = null;
let io = null;

const pending = new Map();

let health = null;
let lastBeat = 0;
let retry = null;
let retryDelay = RETRY_MIN_MS;

function isManuscriptFile(filename) {
    if (!filename) return false;
    const base = path.basename(filename);
    // Skip our own atomic-write temp files; they are never a real change.
    if (base.startsWith('.')) return false;
    return base.toLowerCase().endsWith('.md');
}

/**
 * A watched path is <story>/<chapter>.md relative to the root. Anything
 * shallower or deeper is not a chapter and is ignored.
 */
function parseChapterPath(relative) {
    const parts = relative.split(path.sep).filter(Boolean);
    if (parts.length !== 2) return null;
    return { story: parts[0], chapter: parts[1].replace(/\.md$/i, '') };
}

async function report(relative) {
    const target = parseChapterPath(relative);
    if (!target) return;

    let payload;
    try {
        const data = await ManuscriptService.read(target.story, target.chapter);
        payload = {
            story: target.story,
            chapter: target.chapter,
            words: data.words,
            pages: data.pages,
            modified: data.modified,
            // modified 0 means read() found nothing — the file was deleted.
            deleted: data.modified === 0
        };
    } catch (err) {
        console.error('[ManuscriptWatcher] Could not read', relative, '-', err.message);
        return;
    }

    io?.emit('manuscript:changed', payload);
}

function schedule(relative) {
    clearTimeout(pending.get(relative));
    pending.set(relative, setTimeout(() => {
        pending.delete(relative);
        report(relative);
    }, DEBOUNCE_MS));
}

/**
 * Whether live updates are actually working, so the client can say so instead
 * of the writer inferring it from an editor that has quietly stopped noticing
 * anything. Emitted whenever it changes, and on request.
 */
function announce() {
    io?.emit('manuscript:watcher', { watching: !!watcher, root: watchedRoot });
}

/* ---------- the watch itself ---------- */

/** Closes the watch and forgets the root. Leaves the health timer running. */
function teardown() {
    if (watcher) {
        watcher.close();
        watcher = null;
    }
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    watchedRoot = null;
}

function arm(root) {
    try {
        // recursive works on Windows and macOS. On Linux it needs Node 20+;
        // a failure here is not fatal, it just means no live updates.
        watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
            if (isManuscriptFile(filename)) schedule(filename);
        });

        watcher.on('error', (err) => {
            console.error('[ManuscriptWatcher] Watch failed:', err.message);
            teardown();
            announce();
            scheduleRetry();
        });

        watchedRoot = root;
        retryDelay = RETRY_MIN_MS;
        console.log(`[ManuscriptWatcher] Watching ${root}`);
        announce();
        return true;

    } catch (err) {
        console.error(`[ManuscriptWatcher] Could not watch ${root}: ${err.message}`);
        announce();
        scheduleRetry();
        return false;
    }
}

/**
 * Re-reads the configured root and rebuilds the watch. Used by the retry after
 * an error and by the sleep detector; both want "whatever is correct now"
 * rather than the root we happened to be holding.
 */
async function rearm() {
    const root = await Storage.getStoryRoot();
    teardown();
    if (root) arm(root);
    else announce();
}

function scheduleRetry() {
    clearTimeout(retry);
    const wait = retryDelay;
    console.log(`[ManuscriptWatcher] Retrying in ${Math.round(wait / 1000)}s.`);

    retry = setTimeout(() => {
        retry = null;
        rearm().catch(err => console.error('[ManuscriptWatcher] Retry failed:', err.message));
    }, wait);

    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
}

/**
 * The sleep detector.
 *
 * There is no event for "the laptop lid closed and reopened", and a recursive
 * fs.watch frequently does not survive it — without erroring. So the wall
 * clock is used as the signal: this fires every HEALTH_MS, and if far more
 * than that has passed, the process was suspended and the watch is assumed
 * dead. Rebuilding a live watch costs one syscall, which is cheaper than
 * being wrong about it.
 */
function startHealth() {
    clearInterval(health);
    lastBeat = Date.now();

    health = setInterval(() => {
        const now = Date.now();
        const drift = now - lastBeat;
        lastBeat = now;

        if (drift > SLEEP_GAP_MS) {
            console.log(`[ManuscriptWatcher] Clock jumped ${Math.round(drift / 1000)}s ` +
                '- the machine slept. Rebuilding the watch.');
            rearm().catch(err => console.error('[ManuscriptWatcher] Wake rebuild failed:', err.message));
            return;
        }

        // Also covers the case where the watch was never established, e.g. the
        // story root did not exist at boot and has since been created.
        if (!watcher && !retry) {
            rearm().catch(err => console.error('[ManuscriptWatcher] Recheck failed:', err.message));
        }
    }, HEALTH_MS);

    // Do not hold the process open just for this.
    health.unref?.();
}

/* ---------- public ---------- */

function stop() {
    teardown();
    clearInterval(health);
    health = null;
    clearTimeout(retry);
    retry = null;
    retryDelay = RETRY_MIN_MS;
}

async function start(server) {
    if (server) io = server;

    const root = await Storage.getStoryRoot();

    // Already watching the right place, and the handle is still open.
    if (root === watchedRoot && watcher) {
        startHealth();
        return;
    }

    teardown();
    clearTimeout(retry);
    retry = null;
    retryDelay = RETRY_MIN_MS;

    if (root) arm(root);
    else announce();

    startHealth();
}

/** For a client that connects mid-session and wants to know where it stands. */
function status() {
    return { watching: !!watcher, root: watchedRoot, retrying: !!retry };
}

module.exports = { start, stop, status, announce };
