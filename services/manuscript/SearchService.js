// services/manuscript/SearchService.js

const ManuscriptService = require('./ManuscriptService');
const { lineIndex, lineAt } = require('../proofing/MechanicsText');

/**
 * SearchService
 *
 * Plain-text search across every chapter of one story.
 *
 * Read only, and deliberately so. A cross-chapter REPLACE has no undo, writes
 * to files that are not on screen, and one careless term quietly corrupts a
 * book - a replace of "Rin" turning "during" into "duMinag" in a chapter the
 * writer is not looking at. If replace is ever wanted it needs a
 * preview-every-hit-and-confirm flow, not a function added here.
 *
 * The query is plain text, never a pattern. A novelist should not have to
 * escape a full stop, and "why does searching for the word 'in.' break" is not
 * a conversation worth having. Everything the user types is escaped; the only
 * regex in play is the word boundary this file adds.
 */

/** Characters either side of a hit, for the results list. */
const CONTEXT_CHARS = 70;

/** Hits kept per chapter. The COUNT stays exact - this caps the list only. */
const MAX_HITS_PER_CHAPTER = 100;

class SearchService {
    /**
     * @param {string} story
     * @param {string} query
     * @param {object} opts  { caseSensitive, wholeWord }
     */
    async search(story, query, opts = {}) {
        const term = String(query || '');
        if (!term.trim()) {
            return { query: term, chapters: [], total: 0, searched: 0, truncated: false };
        }

        const list = await ManuscriptService.listChapters(story);
        const pattern = buildPattern(term, opts);

        const chapters = [];
        let total = 0;
        let truncated = false;

        for (const entry of list) {
            const { text } = await ManuscriptService.read(story, entry.name);
            const found = findIn(text, pattern);
            if (!found.count) continue;

            total += found.count;
            if (found.truncated) truncated = true;
            chapters.push({ chapter: entry.name, count: found.count, hits: found.hits });
        }

        return { query: term, chapters, total, searched: list.length, truncated };
    }
}

/**
 * The search pattern.
 *
 * Whole-word is a boundary at BOTH ends, which is the part that is easy to get
 * wrong. Appending a space to the term looks like it does the job and does not:
 * it leaves the front of the word unguarded, so "Rin " still matches inside
 * "Mandarin ", and it loses every hit followed by punctuation - which in
 * dialogue is most of them, because a name at the end of a line is followed by
 * a comma, a full stop or a newline far more often than by a space.
 *
 * Lookarounds rather than \b, because \b is defined on [A-Za-z0-9_] and a
 * manuscript is full of invented names with accents. \bRenée\b does not behave
 * the way anyone expects; the Unicode property escapes below do.
 */
function buildPattern(term, { caseSensitive = false, wholeWord = false } = {}) {
    const escaped = escapeRegex(term);
    const body = wholeWord
        ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`
        : escaped;

    // 'u' is required for \p{...}; 'g' to walk every hit.
    return new RegExp(body, `gu${caseSensitive ? '' : 'i'}`);
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findIn(text, pattern) {
    const body = String(text || '');
    if (!body) return { count: 0, hits: [], truncated: false };

    const starts = lineIndex(body);
    const hits = [];
    let count = 0;
    let match;

    pattern.lastIndex = 0;
    while ((match = pattern.exec(body)) !== null) {
        count += 1;

        if (hits.length < MAX_HITS_PER_CHAPTER) {
            hits.push({
                offset: match.index,
                length: match[0].length,
                line: lineAt(starts, match.index),
                ...split(body, match.index, match[0])
            });
        }

        // A zero-length match cannot happen with a non-empty escaped term, but
        // an empty query reaching here would spin forever. Cheap insurance.
        if (match[0].length === 0) pattern.lastIndex += 1;
    }

    return { count, hits, truncated: count > hits.length };
}

/**
 * The hit split into before / match / after, rather than one string with the
 * position in it. The panel needs to mark the match, and handing it three
 * pieces means it never has to slice by an offset that has already been
 * whitespace-collapsed - which is where an off-by-one would put the highlight
 * on the wrong word.
 */
function split(text, offset, matched) {
    const from = Math.max(0, offset - CONTEXT_CHARS);
    const to = Math.min(text.length, offset + matched.length + CONTEXT_CHARS);

    const before = text.slice(from, offset).replace(/\s+/g, ' ');
    const after = text.slice(offset + matched.length, to).replace(/\s+/g, ' ');

    return {
        before: (from > 0 ? '...' : '') + before,
        match: matched,
        after: after + (to < text.length ? '...' : '')
    };
}

module.exports = new SearchService();
