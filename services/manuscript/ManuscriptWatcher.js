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

const fs = require('fs');
const path = require('path');

const Storage = require('../StorageService');
const ManuscriptService = require('./ManuscriptService');

// Windows fires several events for one save — fs.watch reports the rename and
// the size change separately, and the atomic temp+rename adds more. Coalesce.
const DEBOUNCE_MS = 200;

let watcher = null;
let watchedRoot = null;
let io = null;
const pending = new Map();

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

function stop() {
    if (watcher) {
        watcher.close();
        watcher = null;
    }
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    watchedRoot = null;
}

async function start(server) {
    if (server) io = server;

    const root = await Storage.getStoryRoot();
    if (root === watchedRoot) return;

    stop();
    if (!root) return;

    try {
        // recursive works on Windows and macOS. On Linux it needs Node 20+;
        // a failure here is not fatal, it just means no live updates.
        watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
            if (isManuscriptFile(filename)) schedule(filename);
        });
        watcher.on('error', err => {
            console.error('[ManuscriptWatcher] Stopped:', err.message);
            stop();
        });
        watchedRoot = root;
        console.log(`[ManuscriptWatcher] Watching ${root}`);
    } catch (err) {
        console.error(`[ManuscriptWatcher] Could not watch ${root}: ${err.message}`);
    }
}

module.exports = { start, stop };
