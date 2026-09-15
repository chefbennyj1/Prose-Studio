// services/proofing/AdverbService.js

const {
    KINDS, KIND_NOTES, SPEECH_VERBS, WEAK_VERBS, isRedundant, isAdverb
} = require('./AdverbLexicon');
const { lineIndex, lineAt, splitParagraphs, findQuotes, makeInQuote } = require('./MechanicsText');

/**
 * AdverbService
 *
 * Weak adverbs across a whole manuscript, sorted into the four edits they
 * actually represent. See AdverbLexicon for why a flat -ly count is the wrong
 * feature and what the four kinds mean.
 *
 * Whole-story rather than per-chapter, for the reason OveruseService gives:
 * a writer cannot see their own tics a chapter at a time, because they never
 * read the book the way a reader does. Four "carefully"s in a chapter is
 * nothing; ninety across a novel is a habit.
 *
 * Local, exact, no model. The offsets are where the word was found rather than
 * where anything claimed it was, which is the contract every check in this
 * folder keeps - and the reason it matters is that these numbers are the
 * evidence the writer acts on. A plausible-but-wrong count is undetectable
 * from the panel.
 *
 * NOTHING HERE IS CALLED AN ERROR. The panel reports a rate and a kind and
 * lets the writer look. "Never use adverbs" is advice for undergraduates, and
 * Stephen King - whose "the road to hell is paved with adverbs" is where the
 * rule comes from - wrote it in a book containing several thousand of them.
 */

/** How much text travels with each occurrence so the panel can show it. */
const CONTEXT_CHARS = 90;

/**
 * Occurrences kept per word. The COUNT stays exact - this caps only the
 * examples carried back.
 *
 * A hundred rather than the overuse scan's forty, because the panel LISTS these
 * rather than showing three of them. A writer doing a deliberate pass on
 * "carefully" wants every one, and being handed forty of ninety with no way to
 * the rest is the letdown the list exists to avoid. Above a hundred the cap
 * stops protecting anything worth protecting: the long tail of adverbs never
 * reaches it, so raising it further only inflates the handful of words a writer
 * is going to fix by rewriting rather than by visiting.
 *
 * Whether a row was cut is reported as `truncated`, because a row that says 90
 * and lists 100 of them badly is indistinguishable from a bug.
 */
const MAX_OCCURRENCES = 100;

/** Words, including the apostrophes and hyphens that belong inside them. */
const WORD_PATTERN = /[\p{L}][\p{L}'’-]*/gu;

class AdverbService {

    /** The kinds, for the rail's toggles. */
    describe() {
        return {
            kinds: Object.entries(KINDS).map(([id, label]) => ({
                id, label, note: KIND_NOTES[id]
            }))
        };
    }

    /**
     * @param {Array<{ chapter: string, text: string }>} chapters
     * @param {object} opts  { disabled: [kind] }
     * @returns {object} the report
     */
    scan(chapters, opts = {}) {
        const disabled = new Set(opts.disabled || []);

        /*
         * PASS ONE: which -ly words in this manuscript are people.
         *
         * "Emily", "Holly", "Kelly", "Beverly", "Italy", "Sicily". Morphology
         * cannot tell these from adverbs - they end in -ly and they are not in
         * NOT_ADVERB, because no fixed list can hold the cast of an unwritten
         * novel. A capital letter alone does not settle it either, since
         * "Slowly, he turned" opens a sentence in exactly the same shape.
         *
         * What settles it is how the word is capitalised across the WHOLE book,
         * which is why this is a separate pass rather than a test inside the
         * count - the evidence for chapter one is in chapter nine. See
         * #nameVerdict for the two rules.
         *
         * Without this, a novel with an Emily in it is told she is its most
         * overused adverb.
         */
        const casing = new Map();
        for (const { text } of chapters) {
            this.#collectCasing(String(text || ''), casing);
        }
        const names = this.#nameVerdict(casing);

        const tally = new Map();
        const kindTotals = {};
        for (const id of Object.keys(KINDS)) {
            kindTotals[id] = { id, label: KINDS[id], note: KIND_NOTES[id], total: 0 };
        }

        let totalWords = 0;
        const perChapter = [];

        // PASS TWO: the count.
        for (const { chapter, text } of chapters) {
            const body = String(text || '');
            const words = countWords(body);
            totalWords += words;

            const found = this.scanOne(body, { chapter, names, disabled, tally, kindTotals });
            perChapter.push({ chapter, words, total: found });
        }

        const words = [...tally.values()]
            .filter(row => row.total > 0)
            .map(row => ({
                ...row,
                // The number that survives comparison between a novella and a
                // doorstop, and the only one worth ranking on.
                per10k: totalWords ? round1((row.total / totalWords) * 10000) : 0,
                // The count is exact; the examples are capped. Say so per row,
                // so "90 uses" listing 100 entries is never read as a miscount.
                truncated: row.total > row.occurrences.length
            }))
            .sort((a, b) => b.total - a.total || a.word.localeCompare(b.word));

        const total = words.reduce((sum, row) => sum + row.total, 0);
        const narration = words.reduce((sum, row) => sum + row.narration, 0);

        return {
            words,
            kinds: Object.values(kindTotals),
            chapters: perChapter,
            names: [...names].sort(),
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
     * of the check rather than a refinement of it. A character who says "I
     * walked really slowly" is being characterised - people talk in adverbs -
     * and flattening that out is how every character ends up sounding like the
     * narrator. Reporting one number for both would tell a writer with a lot of
     * dialogue that they have a problem they do not have.
     */
    scanOne(text, { chapter, names, disabled, tally, kindTotals }) {
        if (!text.trim()) return 0;

        const starts = lineIndex(text);
        const paragraphs = splitParagraphs(text);
        const quotes = findQuotes(text, paragraphs);
        const inQuote = makeInQuote(quotes);
        const spoken = paragraphsWithSpeech(paragraphs, quotes);

        const tokens = tokenise(text);
        let added = 0;

        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            const word = normalise(token.word);

            if (!isAdverb(word) || names.has(word)) continue;

            const { kind, verb } = this.#classify({
                text, tokens, index: i, word,
                inQuote, spoken, paragraphs
            });

            if (disabled.has(kind)) continue;

            const row = rowFor(tally, word);
            const quoted = inQuote(token.start);

            row.total += 1;
            if (quoted) row.dialogue += 1; else row.narration += 1;
            row.kinds[kind] += 1;
            kindTotals[kind].total += 1;
            added += 1;

            const last = row.chapters[row.chapters.length - 1];
            if (last && last.chapter === chapter) last.count += 1;
            else row.chapters.push({ chapter, count: 1 });

            if (row.occurrences.length < MAX_OCCURRENCES) {
                const { context, contextOffset } = contextAround(text, token.start, token.word.length);
                row.occurrences.push({
                    chapter,
                    offset: token.start,
                    line: lineAt(starts, token.start),
                    inQuote: quoted,
                    quote: token.word,
                    length: token.word.length,
                    kind,
                    verb: verb || null,
                    context,
                    contextOffset
                });
            }
        }

        return added;
    }

    /**
     * Which of the four kinds this occurrence is, and the verb that decided it.
     *
     * The verb is looked for on BOTH sides. "Said softly" and "softly said" are
     * the same sentence and a writer who inverts for rhythm should not fall off
     * the check - but the word before is tried first, because the adverb after
     * its verb is much the commoner shape and trying the other order first
     * would let "quietly, the door opened" attach to "opened" when "quietly"
     * belongs to the sentence before it.
     *
     * Precedence is redundant > tag > propping > loose. "Whispered quietly" is
     * both redundant and a dialogue tag; redundant wins because it is the only
     * one of the four where the edit is certain - the adverb comes out and
     * nothing is lost.
     */
    #classify({ text, tokens, index, word, inQuote, spoken, paragraphs }) {
        const token = tokens[index];
        const candidates = [];

        const before = tokens[index - 1];
        const after = tokens[index + 1];
        if (before && adjacent(text, before.end, token.start)) candidates.push(before);
        if (after && adjacent(text, token.end, after.start)) candidates.push(after);

        for (const candidate of candidates) {
            if (isRedundant(word, normalise(candidate.word))) {
                return { kind: 'redundant', verb: candidate.word };
            }
        }

        /*
         * A dialogue tag needs three things, not one: a speech verb, an adverb
         * OUTSIDE the quotation marks, and a quotation in the paragraph at all.
         *
         * The third is what keeps "he asked quietly whether she had eaten" out
         * of the list - a speech verb in ordinary narration with no speech
         * attached to it. Without that test the tag count is inflated by
         * reported speech, and the one number in this panel that a writer
         * should act on hardest becomes the one they trust least.
         */
        if (!inQuote(token.start) && spoken.has(paragraphAt(paragraphs, token.start))) {
            for (const candidate of candidates) {
                if (SPEECH_VERBS.has(normalise(candidate.word))) {
                    return { kind: 'tag', verb: candidate.word };
                }
            }
        }

        for (const candidate of candidates) {
            if (WEAK_VERBS.has(normalise(candidate.word))) {
                return { kind: 'propping', verb: candidate.word };
            }
        }

        return { kind: 'loose', verb: null };
    }

    /**
     * How every -ly word in one chapter was capitalised. See the note in
     * scan(); the verdict is reached in #nameVerdict once the whole book has
     * been looked at.
     */
    #collectCasing(text, into) {
        const paragraphs = splitParagraphs(text);
        const tokens = tokenise(text);

        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            const word = normalise(token.word);
            if (!word.endsWith('ly')) continue;

            let seen = into.get(word);
            if (!seen) {
                seen = { capMid: 0, capStart: 0, lower: 0 };
                into.set(word, seen);
            }

            if (token.word[0] === token.word[0].toLowerCase()) seen.lower += 1;
            else if (isSentenceStart(text, tokens, i, paragraphs)) seen.capStart += 1;
            else seen.capMid += 1;
        }
    }

    /**
     * Which -ly words are people, given how the whole manuscript spells them.
     *
     * Two rules, and the second is the one that earns its place:
     *
     *   A capital MID-SENTENCE is decisive. An adverb has no reason to have
     *   one, so a single "and Emily did not look" settles Emily for the whole
     *   book - including the sentence starts, which could never be judged on
     *   their own.
     *
     *   A word that is ALWAYS capitalised and never once lower-case is a name
     *   too. This is the case the first rule misses entirely: a character who
     *   happens only ever to open sentences. Over a whole manuscript a real
     *   adverb lands mid-sentence sooner or later - "slowly" cannot open every
     *   sentence it appears in - so never appearing lower-case is strong
     *   evidence, and requiring two uses keeps a single stylistic "Suddenly,"
     *   at the top of a chapter from disqualifying the word.
     *
     * Both are deliberately biased toward calling a word a name. A missed
     * adverb costs the writer one row in a list; a character counted as an
     * adverb puts the protagonist at the top of the report and discredits the
     * whole panel.
     */
    #nameVerdict(casing) {
        const names = new Set();
        for (const [word, seen] of casing) {
            if (seen.capMid > 0) names.add(word);
            else if (seen.lower === 0 && seen.capStart >= 2) names.add(word);
        }
        return names;
    }
}

/* ---------- text helpers ---------- */

/** Every word in the text, with its offsets. One pass, reused by both passes. */
function tokenise(text) {
    const tokens = [];
    WORD_PATTERN.lastIndex = 0;

    let match;
    while ((match = WORD_PATTERN.exec(text)) !== null) {
        tokens.push({ word: match[0], start: match.index, end: match.index + match[0].length });
    }
    return tokens;
}

/** Lower-cased, with a possessive 's stripped. */
function normalise(word) {
    return String(word).toLowerCase().replace(/[’']s$/, '');
}

/**
 * Whether two words are close enough to modify each other.
 *
 * Only whitespace, quotation marks and commas may sit between them. A full
 * stop, a semicolon or a blank line means the next word belongs to a different
 * sentence, and attaching an adverb across that boundary is how "He walked.
 * Slowly, the door opened" gets reported as "walked slowly" - a sentence the
 * writer never wrote and cannot find.
 */
function adjacent(text, from, to) {
    if (to <= from) return true;
    const between = text.slice(from, to);
    if (between.length > 12) return false;
    return !/[.!?;:…]/.test(between) && !/\n/.test(between);
}

/** Index of the paragraph containing an offset, by binary search. */
function paragraphAt(paragraphs, offset) {
    let lo = 0;
    let hi = paragraphs.length - 1;

    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (paragraphs[mid].start <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
}

/** The indices of paragraphs that contain at least one quotation. */
function paragraphsWithSpeech(paragraphs, quotes) {
    const spoken = new Set();
    for (const quote of quotes) spoken.add(paragraphAt(paragraphs, quote.start));
    return spoken;
}

/**
 * Whether the token at `index` opens a sentence.
 *
 * Used only by the name pass, where the question is "could this capital be
 * grammar rather than a name". An opening quotation mark counts as still being
 * at the start, so the "Slowly" in `"Slowly," she said` is not mistaken for a
 * surname.
 */
function isSentenceStart(text, tokens, index, paragraphs) {
    if (index === 0) return true;

    const token = tokens[index];
    const paragraph = paragraphs[paragraphAt(paragraphs, token.start)];
    if (paragraph && paragraph.start === token.start) return true;

    const between = text.slice(tokens[index - 1].end, token.start);
    return /[.!?…\n]/.test(between);
}

/**
 * Enough text around a hit to judge it without opening the chapter.
 *
 * Grown out to whitespace on both sides so the panel never shows half a word,
 * and marked with an ellipsis where it was cut so the writer can see that it
 * was.
 *
 * Returns WHERE THE WORD IS inside that string as well as the string, because
 * the panel marks the adverb in its own sentence and cannot find it by
 * searching: "carefully, and then more carefully" contains the word twice, and
 * a search would mark the first every time regardless of which one was found.
 * Editor.js already has `markQuote` for exactly this and it wants
 * `contextOffset` - the same contract the mechanics findings keep.
 *
 * The offset has to be computed AFTER the whitespace collapse, not before. A
 * manuscript wraps mid-sentence, so a context spanning a line break is a
 * character shorter once the newline becomes a space, and an offset taken from
 * the raw text lands one place to the left - which markQuote's guard would
 * catch, silently refusing to mark anything at all.
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

    const prefix = from > 0 ? '...' : '';
    const head = text.slice(from, offset).replace(/\s+/g, ' ').replace(/^\s+/, '');
    const word = text.slice(offset, offset + length);
    const tail = text.slice(offset + length, to).replace(/\s+/g, ' ').replace(/\s+$/, '');

    return {
        context: `${prefix}${head}${word}${tail}${to < text.length ? '...' : ''}`,
        contextOffset: prefix.length + head.length
    };
}

function rowFor(tally, word) {
    let row = tally.get(word);
    if (!row) {
        row = {
            word,
            total: 0,
            narration: 0,
            dialogue: 0,
            kinds: Object.fromEntries(Object.keys(KINDS).map(id => [id, 0])),
            chapters: [],
            occurrences: []
        };
        tally.set(word, row);
    }
    return row;
}

function countWords(text) {
    const match = String(text || '').match(/\b[\w'’-]+\b/g);
    return match ? match.length : 0;
}

function round1(value) {
    return Math.round(value * 10) / 10;
}

module.exports = new AdverbService();
