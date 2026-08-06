/**
 * Markdown in, speakable paragraphs out.
 *
 * This is the layer that decides whether the narrator sounds like a reader or
 * like a screen reader, and almost none of it is the model's doing. Two jobs:
 *
 *   1. Take the Markdown off. Left in, the voice says "hash hash Chapter One"
 *      and reads a scene break as "asterisk asterisk asterisk".
 *   2. Say where the paragraphs and scene breaks are, because the silences
 *      between them are what a listener hears as structure. A narrator that
 *      runs paragraphs together is exhausting however good the voice is.
 *
 * This began life in the browser, next to the old Kokoro narrator, and it
 * carried a lot of chunking machinery with it: a character cap, a one-sentence
 * limit per call, a smaller first chunk to shorten the wait before the first
 * word. All of that existed because Kokoro came apart on long input and had to
 * race playback. Piper renders whole paragraphs cleanly and faster than they
 * play, so the chunking is gone and a paragraph is simply a paragraph - which
 * also sounds better, because prosody holds across the sentences inside it
 * instead of resetting at every full stop.
 *
 * splitSentences survives because PiperService needs it: some voices truncate
 * long input and have to be fed a sentence at a time.
 */

// Survives emphasis stripping because it contains no Markdown characters.
const SCENE_MARK = ' SCENE ';

const ABBREVIATIONS = /\b(?:mr|mrs|ms|dr|prof|st|sr|jr|lt|capt|sgt|rev|hon|vs|etc|no|fig|al)\.$/i;

/**
 * Swaps words the narrator says wrongly for a respelling it says correctly.
 *
 * Runs on the text on its way to the voice and nowhere else - the manuscript
 * still says Silas. Applied before paragraphs are split out so a replacement
 * can never be cut in half, and case is matched loosely because a name is a
 * name at the start of a sentence too.
 *
 * Keys are escaped before going into the pattern: an invented name is exactly
 * the sort of thing that turns out to contain a full stop or an apostrophe,
 * and an unescaped one would quietly match the wrong words.
 */
function applyLexicon(text, lexicon) {
    const words = Object.keys(lexicon || {}).filter(Boolean);
    if (!words.length) return text;

    // Longest first, so "Silas Vance" wins over "Silas" when both are listed.
    const pattern = words
        .sort((a, b) => b.length - a.length)
        .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');

    return String(text).replace(new RegExp(`\\b(${pattern})\\b`, 'gi'), (match) => {
        const exact = lexicon[match];
        if (exact) return exact;

        // Fall back to a case-insensitive hit, so one entry covers "silas"
        // at the start of a line and "Silas" mid-sentence.
        const key = words.find(word => word.toLowerCase() === match.toLowerCase());
        return key ? lexicon[key] : match;
    });
}

function stripMarkdown(markdown) {
    let text = String(markdown || '').replace(/\r\n/g, '\n');

    text = text.replace(/^---\n[\s\S]*?\n---\n/, '');                       // yaml frontmatter
    text = text.replace(/```[\s\S]*?```/g, '');                             // fenced code

    // Before emphasis: *** on its own line is a scene break, not empty italics.
    text = text.replace(/^[ \t]*(\*[ \t]*\*[ \t]*\*[\s*]*|-{3,}|_{3,})[ \t]*$/gm, SCENE_MARK);

    text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');                       // images say nothing
    text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');                    // links keep their words
    text = text.replace(/^#{1,6}[ \t]+/gm, '');                             // headings
    text = text.replace(/^[ \t]*>[ \t]?/gm, '');                            // blockquotes
    text = text.replace(/^[ \t]*[-*+][ \t]+/gm, '');                        // bullets
    text = text.replace(/(\*\*|__)(.+?)\1/g, '$2');                         // bold
    text = text.replace(/(\*|_)(.+?)\1/g, '$2');                            // italic
    text = text.replace(/`([^`]+)`/g, '$1');                                // inline code
    text = text.replace(/[ \t]+/g, ' ');

    return text;
}

/**
 * Sentence boundaries, tuned for fiction rather than correctness.
 *
 * Dialogue is the case that matters: `"Get out," he said.` must not break at
 * the comma, and `"Get out." He left.` must break after the quote, not before
 * it. Abbreviations and initials ("Mr. Vance", "T. S. Eliot") are the usual
 * false positives and are checked for explicitly.
 */
function splitSentences(text) {
    const clean = String(text || '').trim();
    if (!clean) return [];

    const out = [];
    const boundary = /[.!?]+["'”’)\]]*\s+/g;
    let start = 0;
    let match;

    while ((match = boundary.exec(clean)) !== null) {
        const end = match.index + match[0].length;
        const candidate = clean.slice(start, end);
        const head = candidate.trimEnd();

        // "Mr." and a bare initial ("T.") are not sentence ends.
        if (ABBREVIATIONS.test(head) || /\b[A-Z]\.$/.test(head)) continue;

        // A following lowercase letter means the stop belonged to something else.
        if (/^[a-z]/.test(clean.slice(end))) continue;

        out.push(candidate.trim());
        start = end;
    }

    const tail = clean.slice(start).trim();
    if (tail) out.push(tail);

    return out.length ? out : [clean];
}

/**
 * Paragraphs and scene breaks in reading order.
 * @returns {Array<{kind: 'text'|'break', text?: string}>}
 */
function toBlocks(prepared) {
    const blocks = [];

    for (const paragraph of String(prepared || '').split(/\n\s*\n/)) {
        paragraph.split(SCENE_MARK).forEach((part, index) => {
            if (index > 0) blocks.push({ kind: 'break' });
            const text = part.replace(/\n/g, ' ').trim();
            if (text) blocks.push({ kind: 'text', text });
        });
    }

    return blocks;
}

/** Markdown straight to the blocks a render walks. */
function planChapter(markdown, lexicon) {
    return toBlocks(applyLexicon(stripMarkdown(markdown), lexicon));
}

module.exports = { applyLexicon, stripMarkdown, splitSentences, toBlocks, planChapter };
