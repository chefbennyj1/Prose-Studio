// Where the manuscript lives on disk, and the directory browser that picks it.
//
// The writer chooses a parent folder in Settings; ManuscriptService builds the
// story/chapter/page tree underneath it. Nothing is written anywhere else, and
// nothing above the parent is reachable once it is set — see assertInsideRoot
// in ManuscriptService.
//
// The browser here is the exception, and it has to be: you cannot pick the
// parent by browsing under the parent. It is admin-only and read-only apart
// from createFolder, and it exists purely to fill in one text field.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const GlobalSettings = require('../models/GlobalSettings');

/**
 * Folder and chapter names, for both the browser's "new folder" and the story
 * tree. Refuses anything that would climb out, hide the entry, or collide with
 * a Windows device name.
 *
 * Stated as what is FORBIDDEN rather than an allowlist of letters and dashes.
 * The allowlist version rejected "Chapter 1 (original pre-refactor)" - a file
 * sitting in a real story folder, written by the writer, perfectly legal on
 * every filesystem - and because listChapters offered it while read() refused
 * it, that one file made its whole story impossible to open. Apostrophes and
 * commas would have done the same to any chapter titled "Mina's Return".
 *
 * The characters below are the ones that are genuinely unsafe: the Windows
 * illegal set, which also covers the separators that would let a name climb
 * out of its parent, plus control characters. Traversal is additionally caught
 * by `..` here and by assertInsideRoot on every path that is built.
 */
const UNSAFE_CHARS = /[<>:"/\\|?*\u0000-\u001F]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const SEGMENT_RULE = 'Names may not contain < > : " / \\ | ? *, may not start with a dot or space, ' +
    'and must be under 120 characters.';

// Kept for callers that want the shape rather than the check.
const SAFE_SEGMENT = /^[^<>:"/\\|?*\u0000-\u001F]{1,120}$/;

exports.SAFE_SEGMENT = SAFE_SEGMENT;
exports.RESERVED = RESERVED;
exports.SEGMENT_RULE = SEGMENT_RULE;

exports.isSafeSegment = (name) => {
    const clean = String(name || '').trim();
    if (!clean || clean.length > 120) return false;
    if (UNSAFE_CHARS.test(clean)) return false;

    // A leading dot hides the entry, and listStories/listChapters both skip
    // dot-entries - so one could be created and then be invisible.
    if (clean.startsWith('.')) return false;

    // Windows silently strips a trailing dot or space, so the name on disk
    // would not be the name that was asked for.
    if (/[. ]$/.test(clean)) return false;

    if (clean.includes('..')) return false;
    if (RESERVED.test(clean)) return false;
    return true;
};

// Read on nearly every manuscript call, changed about once in the life of an
// install. Cached, and busted by setStoryRoot.
let cachedRoot;

exports.getStoryRoot = async () => {
    if (cachedRoot !== undefined) return cachedRoot;
    try {
        const settings = await GlobalSettings.findOne({ key: 'main' }, 'storage').lean();
        cachedRoot = settings?.storage?.storyRoot || '';
    } catch (err) {
        console.error('[Storage] Could not read the story root:', err.message);
        cachedRoot = '';
    }
    return cachedRoot;
};

exports.clearCache = () => { cachedRoot = undefined; };

/**
 * Throws with code NO_STORY_ROOT when nothing is configured, so the editor can
 * point at Settings instead of showing a bare filesystem error.
 */
exports.requireStoryRoot = async () => {
    const root = await exports.getStoryRoot();
    if (!root) {
        const err = new Error('No story folder is set. Choose one in Settings before writing.');
        err.code = 'NO_STORY_ROOT';
        throw err;
    }
    return root;
};

/** Exists, is a directory, and this process can write into it. */
async function assertUsableDirectory(target) {
    let stat;
    try {
        stat = await fsp.stat(target);
    } catch (err) {
        throw new Error(err.code === 'ENOENT' ? 'That folder does not exist.' : `Cannot read that folder: ${err.message}`);
    }
    if (!stat.isDirectory()) throw new Error('That path is a file, not a folder.');

    try {
        await fsp.access(target, fs.constants.W_OK);
    } catch {
        throw new Error('That folder is not writable by the engine.');
    }
}
exports.assertUsableDirectory = assertUsableDirectory;

exports.setStoryRoot = async (rawPath) => {
    const target = path.resolve(String(rawPath || '').trim());
    if (!target) throw new Error('A folder path is required.');

    await assertUsableDirectory(target);

    await GlobalSettings.findOneAndUpdate(
        { key: 'main' },
        { $set: { 'storage.storyRoot': target } },
        { upsert: true, new: true }
    );
    cachedRoot = target;

    console.log(`[Storage] Story root set to ${target}`);
    for (const listener of rootListeners) {
        try { listener(target); } catch (err) { console.error('[Storage] Root listener failed:', err.message); }
    }
    return target;
};

// The watcher needs to follow the root when it moves; nothing else should have
// to poll for it.
const rootListeners = new Set();
exports.onRootChange = (fn) => { rootListeners.add(fn); return () => rootListeners.delete(fn); };

/** Drive letters that currently exist, so the browser has somewhere to start. */
async function listDrives() {
    if (process.platform !== 'win32') return [{ name: '/', path: '/' }];

    const drives = [];
    for (let code = 65; code <= 90; code++) {
        const letter = `${String.fromCharCode(code)}:\\`;
        try {
            await fsp.access(letter, fs.constants.R_OK);
            drives.push({ name: letter, path: letter });
        } catch {
            // Not mounted; skip.
        }
    }
    return drives;
}

/**
 * Lists the sub-directories of a path — files are irrelevant here, the writer
 * is choosing a folder. An entry that cannot be stat'd (permissions, a
 * disconnected network drive) is skipped rather than failing the whole listing.
 */
exports.browse = async (rawPath) => {
    const requested = String(rawPath || '').trim();

    if (!requested) {
        return { path: '', parent: null, isRoot: true, entries: await listDrives() };
    }

    const target = path.resolve(requested);
    await assertUsableDirectory(target).catch(err => { throw new Error(err.message); });

    const dirents = await fsp.readdir(target, { withFileTypes: true });
    const entries = [];

    for (const dirent of dirents) {
        if (!dirent.isDirectory()) continue;
        if (dirent.name.startsWith('.')) continue;
        entries.push({ name: dirent.name, path: path.join(target, dirent.name) });
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    // At a drive root, path.dirname is the drive itself; report null so the UI
    // offers the drive list rather than a button that goes nowhere.
    const parentPath = path.dirname(target);
    const parent = parentPath === target ? '' : parentPath;

    return { path: target, parent, isRoot: false, entries };
};

exports.createFolder = async (parentPath, name) => {
    const clean = String(name || '').trim();
    if (!exports.isSafeSegment(clean)) throw new Error(`Invalid folder name. ${SEGMENT_RULE}`);

    const parent = path.resolve(String(parentPath || '').trim());
    await assertUsableDirectory(parent);

    const target = path.join(parent, clean);
    if (path.dirname(target) !== parent) throw new Error(`Invalid folder name. ${SEGMENT_RULE}`);

    try {
        await fsp.mkdir(target);
    } catch (err) {
        if (err.code === 'EEXIST') throw new Error('A folder with that name already exists here.');
        throw err;
    }

    return { name: clean, path: target };
};
