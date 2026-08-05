const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const Storage = require('../StorageService');

/**
 * ManuscriptService
 *
 * Plain Markdown on disk, in the shape a book already has:
 *
 *     <story root>/                chosen in Settings — see StorageService
 *     └── The Long Cold/           a story
 *         ├── Chapter One.md       a chapter
 *         └── Chapter Two.md
 *
 * A chapter is ONE file. Pages are not stored, they are computed — see
 * PAGE_WORDS below and the page rules drawn in the editor. Storing one file
 * per page was the earlier design and it cannot survive computed pagination:
 * prose reflows as you edit, so the boundaries move on every keystroke and the
 * files would need re-splitting under the writer's hands. Text the writer is
 * still typing is the last thing that should be getting cut in half.
 *
 * Nothing lives outside the configured root, and no name may climb out of it —
 * every segment is validated and the resolved path is re-checked against the
 * root before any read or write.
 *
 * WRITES ARE ATOMIC. Text goes to a temp file and is renamed over the target,
 * and a save carries the mtime it was based on. Two editor tabs, or a save
 * landing while a background proofing scan is in flight, would otherwise
 * silently lose a night's writing — the one bug this application cannot
 * afford. fs.rename replaces the destination on both Windows and POSIX, so a
 * reader sees the old file whole or the new file whole, never a partial one.
 */

const NAME_RULE = Storage.SEGMENT_RULE;

function cleanSegment(value, label) {
    const clean = String(value || '').trim();
    if (!Storage.isSafeSegment(clean)) {
        throw new Error(`Invalid ${label} name. ${NAME_RULE}`);
    }
    return clean;
}

/**
 * Belt and braces on top of the per-segment validation: whatever the segments
 * were, the path they produced must still sit inside the root.
 */
function assertInsideRoot(root, target) {
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('That location is outside the story folder.');
    }
    return target;
}

async function resolveStory(story) {
    const root = await Storage.requireStoryRoot();
    return assertInsideRoot(root, path.join(root, cleanSegment(story, 'story')));
}

async function resolveChapter(story, chapter) {
    const root = await Storage.requireStoryRoot();
    const clean = cleanSegment(String(chapter || '').replace(/\.md$/i, ''), 'chapter');
    const target = path.join(root, cleanSegment(story, 'story'), `${clean}.md`);
    assertInsideRoot(root, target);
    return { clean, target };
}

/**
 * Standard manuscript format: 250 words to the page — 12pt Courier,
 * double-spaced, one-inch margins. It is the number publishers estimate
 * length with, which makes it the right one to show a writer. A typeset
 * trade paperback runs 250–300, so this errs slightly long, in the writer's
 * favour. The editor draws its page rules from the same constant.
 */
const PAGE_WORDS = 250;

function countWords(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).length;
}

function countPages(words) {
    return Math.max(1, Math.ceil(words / PAGE_WORDS));
}

/** Sub-directory names, skipping hidden folders. A missing parent lists empty. */
async function subdirectories(dir) {
    let dirents;
    try {
        dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
    return dirents
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .map(d => d.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

async function markdownFiles(dir) {
    let dirents;
    try {
        dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
    return dirents
        .filter(d => d.isFile() && d.name.toLowerCase().endsWith('.md') && !d.name.startsWith('.'))
        .map(d => d.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

class ManuscriptService {

    /* ---------- stories ---------- */

    // Chapter counts only. Word counts here would mean reading every file in
    // the library to render a dropdown.
    async listStories() {
        const root = await Storage.requireStoryRoot();
        const names = await subdirectories(root);

        const stories = [];
        for (const name of names) {
            stories.push({ name, chapters: (await markdownFiles(path.join(root, name))).length });
        }
        return stories;
    }

    async createStory(name) {
        const target = await resolveStory(name);
        try {
            await fsp.mkdir(target);
        } catch (err) {
            if (err.code === 'EEXIST') throw new Error('A story with that name already exists.');
            throw err;
        }
        return { name: path.basename(target), chapters: 0 };
    }

    /* ---------- chapters ---------- */

    // Bounded by one story, so reading each chapter for a word count is fine
    // here in a way it would not be across the whole library.
    async listChapters(story) {
        const storyPath = await resolveStory(story);
        const files = await markdownFiles(storyPath);

        const chapters = [];
        for (const file of files) {
            const full = path.join(storyPath, file);
            const [text, stat] = await Promise.all([
                fsp.readFile(full, 'utf8').catch(() => ''),
                fsp.stat(full)
            ]);
            const words = countWords(text);
            chapters.push({
                name: file.replace(/\.md$/i, ''),
                words,
                pages: countPages(words),
                modified: stat.mtimeMs
            });
        }
        return chapters;
    }

    async createChapter(story, name) {
        const storyPath = await resolveStory(story);
        try {
            await fsp.stat(storyPath);
        } catch {
            throw new Error('That story does not exist.');
        }

        const { clean, target } = await resolveChapter(story, name);
        try {
            // wx: never clobber an existing chapter with an empty one.
            await fsp.writeFile(target, '', { encoding: 'utf8', flag: 'wx' });
        } catch (err) {
            if (err.code === 'EEXIST') throw new Error('A chapter with that name already exists in this story.');
            throw err;
        }

        const stat = await fsp.stat(target);
        return { name: clean, words: 0, pages: 1, modified: stat.mtimeMs };
    }

    /* ---------- reading and writing a chapter ---------- */

    async read(story, chapter) {
        const { clean, target } = await resolveChapter(story, chapter);
        try {
            const [text, stat] = await Promise.all([
                fsp.readFile(target, 'utf8'),
                fsp.stat(target)
            ]);
            const words = countWords(text);
            return { story, name: clean, text, words, pages: countPages(words), modified: stat.mtimeMs };
        } catch (err) {
            if (err.code === 'ENOENT') {
                return { story, name: clean, text: '', words: 0, pages: 1, modified: 0 };
            }
            throw err;
        }
    }

    /**
     * @param {number|null} baseModified  mtime the edit was made against.
     *        When it no longer matches, the file changed underneath the writer
     *        and the save is refused rather than silently overwriting.
     */
    async write(story, chapter, text, baseModified = null) {
        const { clean, target } = await resolveChapter(story, chapter);
        if (typeof text !== 'string') throw new Error('Chapter text must be a string.');

        const storyPath = path.dirname(target);
        try {
            await fsp.stat(storyPath);
        } catch {
            throw new Error('That story no longer exists on disk.');
        }

        if (baseModified) {
            let current = 0;
            try {
                current = (await fsp.stat(target)).mtimeMs;
            } catch (err) {
                if (err.code !== 'ENOENT') throw err;
            }
            // Compare on whole milliseconds; some filesystems round the value
            // returned by stat differently from the one recorded on write.
            if (current && Math.abs(current - baseModified) > 1) {
                const conflict = new Error('This chapter changed on disk since you opened it. Reload before saving, or your edit would overwrite the newer version.');
                conflict.code = 'STALE_WRITE';
                conflict.currentModified = current;
                throw conflict;
            }
        }

        // The temp file sits beside the target: rename is only atomic within a
        // filesystem, and the story folder is certain to be on the same one.
        const temp = path.join(storyPath, `.${clean}.${process.pid}.${Date.now()}.tmp`);
        try {
            await fsp.writeFile(temp, text, 'utf8');
            await fsp.rename(temp, target);
        } catch (err) {
            await fsp.unlink(temp).catch(() => {});
            throw err;
        }

        const stat = await fsp.stat(target);
        const words = countWords(text);
        return { story, name: clean, words, pages: countPages(words), modified: stat.mtimeMs };
    }
}

module.exports = new ManuscriptService();
module.exports.countWords = countWords;
module.exports.countPages = countPages;
module.exports.PAGE_WORDS = PAGE_WORDS;
