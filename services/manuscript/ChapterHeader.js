/**
 * ChapterHeader
 *
 * Settings for one chapter, kept at the top of its own .md file:
 *
 *     ---
 *     music: rain-on-glass.mp3
 *     ---
 *     The rain had not stopped for three days...
 *
 * IN THE FILE, NOT BESIDE IT. A sidecar file has to be renamed, moved and
 * deleted with its chapter by every piece of code that ever does those things,
 * and the one that forgets leaves settings attached to nothing. A header goes
 * wherever the chapter goes.
 *
 * NOTHING OUTSIDE ManuscriptService EVER SEES IT. read() hands out the body
 * only, so the editor, word counts, proofing, search and above all the
 * narrator work on prose and cannot count, flag or speak a setting. write()
 * puts the header from disk back on top, so an editor save cannot erase it.
 *
 * STRICT ON PURPOSE. A chapter may well open with a scene break, and "---" is
 * one. So a block only counts as a header when EVERY line inside it is
 * `key: value` (or blank). A passage of prose between two scene breaks never
 * is, and is left exactly where the writer put it.
 *
 * AND ONLY KNOWN KEYS. 'Tuesday: morning' between two scene breaks is a line of
 * prose that happens to have a colon in it. A key this app does not use means
 * the block is not ours. Add a key to KEYS when a chapter setting is added.
 *
 * Deliberately not YAML. One level of `key: value` is all a chapter needs, and
 * a parser that understands less cannot misread prose as something more.
 */

const HEADER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;
const KEYS = new Set(['music']);
const LINE = /^([A-Za-z][\w-]*)[ \t]*:[ \t]*(.*?)[ \t]*$/;

/**
 * @returns {{ meta: object, body: string }} meta is {} and body the whole
 *          text when there is no header.
 */
function split(raw) {
    const text = String(raw ?? '');
    const match = HEADER.exec(text);
    if (!match) return { meta: {}, body: text };

    const meta = {};
    for (const line of match[1].split(/\r?\n/)) {
        if (!line.trim()) continue;
        const pair = LINE.exec(line);
        if (!pair || !KEYS.has(pair[1])) return { meta: {}, body: text };   // prose, not a header
        meta[pair[1]] = pair[2];
    }
    // Two scene breaks with nothing between them are two scene breaks.
    if (!Object.keys(meta).length) return { meta: {}, body: text };
    return { meta, body: text.slice(match[0].length) };
}

/**
 * The header for these settings, or '' when there are none - a chapter with
 * nothing set goes back to being plain prose.
 */
function build(meta) {
    const lines = Object.entries(meta || {})
        .filter(([key, value]) => KEYS.has(key) && value !== null && value !== undefined && String(value).trim() !== '')
        .map(([key, value]) => `${key}: ${String(value).replace(/[\r\n]+/g, ' ').trim()}`);
    return lines.length ? `---\n${lines.join('\n')}\n---\n` : '';
}

module.exports = { split, build, KEYS };
