// services/proofing/OveruseService.js

const { GROUPS, WORDS, CONTEXTUAL } = require('./OveruseLexicon');
const { lineIndex, lineAt, splitParagraphs, findQuotes, makeInQuote } = require('./MechanicsText');

/**
 * OveruseService
 *
 * Counts intensifiers and absolutes across a whole manuscript.
 *
 * Why a whole manuscript and not a chapter: this is the one check that cannot
 * work per-chapter. Three "suddenly"s in a chapter is normal writing. Sixty
 * across a book is a tic, and the writer cannot see it because they never read
 * the book the way a reader does - in one pass, close together. Counting is
 * cheap enough that scope costs nothing, so the default is everything.
 *
 * Nothing here calls a model. The offsets are where the match was found rather
 * than where anything claimed it was, so a finding is exact by construction -
 * the same contract MechanicsService keeps, and for the same reason: these
 * numbers are the evidence the writer acts on, and a plausible-but-wrong count
 * is undetectable from the panel.
 *
 * The rate, not the count, is the number that means something. A 34 is alarming
 * in a short story and unremarkable in a 120,000-word novel, so everything is
 * also reported per 10,000 words.
 */

/** How much text travels with each occurrence so the panel can show it. */
const CONTEXT_CHARS = 90;

/**
 * Occurrences kept per word. The COUNT stays exact - this caps only the
 * examples carried back, because a common word in a long novel would otherwise
 * put tens of thousands of context strings on the wire to fill a list nobody
 * scrolls to the end of.
 */
const MAX_OCCURRENCES = 40;

class OveruseService {
    /** Word and group list, for the rail's toggles. */
    describe() {
        return {
            groups: Object.entries(GROUPS).map(([id, label]) => ({ id, label })),
            words: WORDS.map(({ word, group, note }) => ({ word, group, note }))
        };
    }

    /**
     * @param {Array<{ chapter: string, text: string }>} chapters
     * @param {object} opts  { disabled: [group] }
     * @returns {object} the report
     */
    scan(chapters, opts = {}) {
        const disabled = new Set(opts.disabled || []);
        const active = WORDS.filter(entry => !disabled.has(entry.group));

        const tally = new Map();
        for (const entry of active) {
            tally.set(entry.word, {
                word: entry.word,
                group: entry.group,
                note: entry.note,
                total: 0,
                narration: 0,
                dialogue: 0,
                chapters: [],
                occurrences: []
            });
        }

        let totalWords = 0;
        const perChapter = [];

        for (const { chapter, text } of chapters) {
            const body = String(text || '');
            const words = countWords(body);
            totalWords += words;

            const found = this.scanOne(body, active, chapter, tally);
            perChapter.push({ chapter, words, total: found });
        }

        const words = [...tally.values()]
            .filter(row => row.total > 0)
            .map(row => ({
                ...row,
                // The number that survives comparison between a novella and a
                // doorstop, and the only one worth ranking on.
                per10k: totalWords ? round1((row.total / totalWords) * 10000) : 0
            }))
            .sort((a, b) => b.total - a.total || a.word.localeCompare(b.word));

        const total = words.reduce((sum, row) => sum + row.total, 0);
        const narration = words.reduce((sum, row) => sum + row.narration, 0);

        return {
            words,
            chapters: perChapter,
            stats: {
                words: totalWords,
                chapters: chapters.length,
                distinct: words.length
            },
            counts: {
                total,
                narration,
                dialogue: total - narration,
                per10k: totalWords ? round1((total / totalWords) * 10000) : 0
            }
        };
    }

    /**
     * One chapter, into the running tally. Returns how many hits it added.
     *
     * Dialogue is counted but kept separate, and that distinction is the point
     * of the whole check rather than a refinement of it. A character who says
     * "I'm absolutely certain" is being characterised - people talk in
     * absolutes, and flattening that out is how every character ends up
     * sounding like the narrator. The same phrase in narration is the writer
     * reaching for emphasis. Reporting one number for both would tell a writer
     * with a lot of dialogue that they have a problem they do not have.
     */
    scanOne(text, active, chapter, tally) {
        if (!text.trim()) return 0;

        const starts = lineIndex(text);
        const inQuote = makeInQuote(findQuotes(text, splitParagraphs(text)));

        let added = 0;

        for (const entry of active) {
            const row = tally.get(entry.word);
            const pattern = patternFor(entry.word);
            const gate = CONTEXTUAL[entry.word];

            let match;
            let inChapter = 0;
            pattern.lastIndex = 0;

            while ((match = pattern.exec(text)) !== null) {
                const offset = match.index;

                // "so" and "too" are only intensifiers in front of something an
                // intensifier can modify. See CONTEXTUAL in the lexicon.
                if (gate && !gate(nextWord(text, offset + match[0].length))) continue;

                const quoted = inQuote(offset);
                row.total += 1;
                if (quoted) row.dialogue += 1; else row.narration += 1;
                inChapter += 1;
                added += 1;

                if (row.occurrences.length < MAX_OCCURRENCES) {
                    row.occurrences.push({
                        chapter,
                        offset,
                        line: lineAt(starts, offset),
                        inQuote: quoted,
                        quote: match[0],
                        context: contextAround(text, offset, match[0].length)
                    });
                }
            }

            if (inChapter) row.chapters.push({ chapter, count: inChapter });
        }

        return added;
    }
}

/**
 * A word-boundary pattern for one entry.
 *
 * Multi-word entries match across any single run of whitespace, so "kind of"
 * is still found when the writer happened to break the line between the two
 * words - which in a manuscript is common and would otherwise silently
 * undercount.
 */
function patternFor(word) {
    const parts = word.split(/\s+/).map(escapeRegex);
    return new RegExp(`\\b${parts.join('\\s+')}\\b`, 'gi');
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The next word after an offset, lowercased. '' at the end of the text. */
function nextWord(text, from) {
    const match = /^\s*([A-Za-z']+)/.exec(text.slice(from, from + 40));
    return match ? match[1].toLowerCase() : '';
}

/**
 * Enough text around a hit to judge it without opening the chapter.
 *
 * Grown out to whitespace on both sides so the panel never shows half a word,
 * and marked with an ellipsis where it was cut so the writer can see that it
 * was.
 */
function contextAround(text, offset, length) {
    let from = Math.max(0, offset - CONTEXT_CHARS);
    let to = Math.min(text.length, offset + length + CONTEXT_CHARS);

    if (from > 0) {
        const space = text.indexOf(' ', from);
        if (space !== -1 && space < offset) from = space + 1;
    }
    if (to < text.length) {
        const space = text.lastIndexOf(' ', to);
        if (space !== -1 && space > offset + length) to = space;
    }

    const slice = text.slice(from, to).replace(/\s+/g, ' ').trim();
    return `${from > 0 ? '...' : ''}${slice}${to < text.length ? '...' : ''}`;
}

function countWords(text) {
    const match = String(text || '').match(/\b[\w'’-]+\b/g);
    return match ? match.length : 0;
}

function round1(value) {
    return Math.round(value * 10) / 10;
}

module.exports = new OveruseService();
