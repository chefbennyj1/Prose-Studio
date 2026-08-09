/**
 * MechanicsText
 *
 * Segmentation for the mechanics scanner: lines, paragraphs, sentences, and
 * spans of quoted speech. Every rule in MechanicsRules is written against these
 * rather than against raw regex over the whole document, because almost every
 * mechanical rule in fiction is context-dependent — a comma splice inside
 * dialogue is a character's voice, one in narration is a mistake, and the only
 * thing that tells them apart is knowing where the quotes are.
 *
 * Everything here reports offsets into the ORIGINAL string. Nothing is
 * normalised, trimmed or rebuilt, because the offsets are handed to the editor
 * and used to splice the writer's manuscript. An offset that is off by one
 * corrupts prose the writer never reviewed — the same reasoning that drives
 * SuggestionService.verify().
 */

/** Words that legitimately carry a period without ending a sentence. */
const ABBREVIATIONS = new Set([
    'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'ave', 'rd', 'blvd',
    'mt', 'ft', 'col', 'gen', 'capt', 'lt', 'sgt', 'cpl', 'maj', 'adm', 'rev',
    'hon', 'esq', 'vs', 'etc', 'eg', 'ie', 'cf', 'al', 'inc', 'ltd', 'co',
    'corp', 'dept', 'univ', 'approx', 'no', 'vol', 'fig', 'pp',
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct',
    'nov', 'dec', 'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri',
    'sat', 'sun'
]);

const OPEN_DOUBLE = '"“';
const CLOSE_DOUBLE = '"”';
const ANY_DOUBLE = '"“”';

/**
 * Characters allowed to trail a sentence's terminal punctuation, written as a
 * finished character class. The closing bracket is escaped: left bare it ends
 * the class early, and the boundary pattern then demands a trailer that is
 * almost never there — which silently stops the splitter finding any sentence
 * boundary at all, and hands every rule one sentence per paragraph.
 */
const TRAILER_CLASS = '["”\'’)»›\\]]';

/**
 * Line start offsets, so a finding can report a line number without scanning
 * the document again for every one of them.
 */
function lineIndex(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') starts.push(i + 1);
    }
    return starts;
}

/** 1-based line number for an offset, by binary search over lineIndex(). */
function lineAt(starts, offset) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
}

/**
 * Paragraphs, as the writer sees them.
 *
 * Two conventions are both in the wild and both valid: blank line between
 * paragraphs, or one paragraph per line. Guessing wrong turns a chapter into
 * either one enormous paragraph or a hundred one-line ones, and the layout
 * rules — paragraph length, speaker-per-paragraph — would then be measuring
 * nothing. So the separator is chosen by looking: if the document contains a
 * blank line anywhere, blank lines are the separator; otherwise single
 * newlines are.
 */
function splitParagraphs(text) {
    const separator = /\n[ \t]*\n/.test(text) ? /\n[ \t]*\n+/g : /\n+/g;
    const paragraphs = [];

    let cursor = 0;
    let match;
    separator.lastIndex = 0;

    const push = (start, end) => {
        const raw = text.slice(start, end);
        const lead = raw.length - raw.trimStart().length;
        const body = raw.trim();
        if (body) paragraphs.push({ start: start + lead, end: start + lead + body.length, text: body });
    };

    while ((match = separator.exec(text)) !== null) {
        push(cursor, match.index);
        cursor = match.index + match[0].length;
    }
    push(cursor, text.length);

    return paragraphs;
}

/**
 * Sentences within a paragraph range.
 *
 * A boundary is terminal punctuation, any closing quotes or brackets that
 * belong to it, then whitespace, then something that can open a sentence. The
 * three things that make this more than a one-line regex are all common in
 * prose and all produce wrong offsets when ignored:
 *
 *   - "Mr. Alvarez" is one sentence, not two. Hence ABBREVIATIONS.
 *   - "3.5 miles" is not a boundary. Hence the digit check.
 *   - An ellipsis ends a sentence only sometimes: "I don't... know" continues,
 *     "I don't know..." followed by a capital does not.
 */
function splitSentences(text, from = 0, to = text.length) {
    const sentences = [];
    const boundary = new RegExp(`[.!?…]+${TRAILER_CLASS}*(?=\\s|$)`, 'g');

    let start = from;
    let match;
    boundary.lastIndex = from;

    while ((match = boundary.exec(text)) !== null) {
        if (match.index >= to) break;

        const end = match.index + match[0].length;
        if (end > to) break;

        if (isRealBoundary(text, match, end, to)) {
            push(sentences, text, start, end);
            start = skipSpace(text, end, to);
            boundary.lastIndex = Math.max(boundary.lastIndex, start);
        }
    }

    push(sentences, text, start, to);
    return sentences;
}

function push(sentences, text, start, end) {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (body) sentences.push({ start: start + lead, end: start + lead + body.length, text: body });
}

function skipSpace(text, index, limit) {
    let i = index;
    while (i < limit && /\s/.test(text[i])) i++;
    return i;
}

function isRealBoundary(text, match, end, limit) {
    // Only the terminal marks, without the quotes or brackets riding on them.
    const punctuation = (match[0].match(/^[.!?…]+/) || [''])[0];

    // A decimal point, a version number, an IP address: digits on both sides.
    if (punctuation[0] === '.' && /\d/.test(text[match.index - 1] || '') && /\d/.test(text[end] || '')) {
        return false;
    }

    // The word carrying the period. "Dr." does not end a sentence; neither does
    // a single initial, which is how "J. R. R. Tolkien" stays one sentence.
    if (punctuation === '.') {
        const before = text.slice(Math.max(0, match.index - 20), match.index);
        const word = (before.match(/([A-Za-z']+)$/) || [])[1];
        if (word) {
            if (ABBREVIATIONS.has(word.toLowerCase())) return false;
            if (word.length === 1 && word === word.toUpperCase()) return false;
        }
    }

    // Whatever follows has to be able to start a sentence. An ellipsis or a
    // terminal mark followed by a lowercase letter is mid-sentence.
    const next = skipSpace(text, end, limit);
    if (next >= limit) return true;

    const char = text[next];
    return /[A-Z0-9]/.test(char) || ANY_DOUBLE.includes(char) || '‘’\'—-*('.includes(char);
}

/**
 * Spans of double-quoted speech.
 *
 * Scanned per paragraph and never across one, because an unclosed quote is a
 * real convention in fiction — a speech continuing into the next paragraph
 * deliberately omits its closing mark — and a scanner that ran past the
 * paragraph would swallow all the narration up to the next speaker and report
 * it as dialogue.
 *
 * Straight and curly marks are handled together. Straight quotes are
 * ambiguous by nature (the same character opens and closes), so they simply
 * alternate; curly ones are read as the directional marks they are.
 *
 * @returns {Array<{start, end, inner, innerEnd, closed}>} start/end include the
 *          quote marks; inner/innerEnd bound the speech itself.
 */
function findQuotes(text, paragraphs) {
    const spans = [];

    for (const paragraph of paragraphs) {
        let open = -1;

        for (let i = paragraph.start; i < paragraph.end; i++) {
            const char = text[i];
            if (!ANY_DOUBLE.includes(char)) continue;

            if (open === -1) {
                // A closing curly mark with nothing open is a stray, not an opener.
                if (char === '”') continue;
                open = i;
                continue;
            }

            // An opening curly mark cannot close anything: the previous quote
            // was never closed, so hand it back as an open span and restart.
            if (char === '“') {
                spans.push({ start: open, end: i, inner: open + 1, innerEnd: i, closed: false });
                open = i;
                continue;
            }

            spans.push({ start: open, end: i + 1, inner: open + 1, innerEnd: i, closed: true });
            open = -1;
        }

        if (open !== -1) {
            spans.push({ start: open, end: paragraph.end, inner: open + 1, innerEnd: paragraph.end, closed: false });
        }
    }

    return spans;
}

/** Whether an offset falls inside quoted speech. */
function makeInQuote(spans) {
    return (offset) => spans.some(span => offset >= span.inner && offset < span.innerEnd);
}

module.exports = {
    ABBREVIATIONS,
    OPEN_DOUBLE,
    CLOSE_DOUBLE,
    ANY_DOUBLE,
    lineIndex,
    lineAt,
    splitParagraphs,
    splitSentences,
    findQuotes,
    makeInQuote
};
