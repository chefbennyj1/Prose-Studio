// views/dashboard/components/Editor/WritingFlags.js

/**
 * WritingFlags
 *
 * Finds the things in `dictionaries/writing-flags.json` in a chapter, and says
 * exactly where they are. No model, no network, no server round trip - this
 * runs on every keystroke's worth of change, so it has to be cheap enough that
 * the writer never feels it.
 *
 * The offsets are where the match was found rather than where anything claimed
 * it was, which is the same contract MechanicsService and OveruseService keep.
 * A highlight that lies about the text under it is worse than no highlight.
 *
 * WHY ONE REGEX PER CATEGORY, NOT ONE PER TERM
 *
 * There are around 900 literal terms. Running 900 regexes over a 100,000
 * character chapter on every change is 90 million character comparisons and a
 * visibly janky editor. One alternation per category is seven passes total, and
 * the engine's own alternation matching does the work in C++ rather than in a
 * JavaScript loop.
 *
 * Terms are sorted LONGEST FIRST inside the alternation. JavaScript alternation
 * is first-match-wins, not longest-match-wins, so "in a way" placed after "in a
 * sense" is fine but "realm" placed before "in the realm of" would match the
 * short one and leave the phrase unflagged.
 */

/**
 * Word boundaries, done properly.
 *
 * `\b` is defined on [A-Za-z0-9_], so it breaks on exactly the words a novel is
 * full of: it will not match at the edge of "Renee" if the name is written
 * "Renée", and it treats an apostrophe as a boundary so "it's" is seen as "it"
 * + "s". These lookarounds use the Unicode letter and number classes instead,
 * which is what the manuscript search already does - see Agents.md.
 */
const OPEN = "(?<![\\p{L}\\p{N}_])";
const CLOSE = "(?![\\p{L}\\p{N}_])";

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One term, as a regex fragment.
 *
 * Whitespace inside a phrase becomes `\s+` so a phrase still matches when the
 * writer happened to break the line in the middle of it - which in a manuscript
 * is common, and would otherwise silently miss. Apostrophes match both the
 * straight and the curly form, because the editor's own smart-quote handling
 * turns one into the other as you type and the list is written with straight
 * ones.
 */
function termToPattern(term) {
    return escapeRegex(term)
        .split(/\s+/)
        .join('\\s+')
        .replace(/'/g, "['’]");
}

/** One alternation for a whole category, longest term first. */
function buildAlternation(terms) {
    const sorted = [...terms].sort((a, b) => b.length - a.length);
    const body = sorted.map(termToPattern).join('|');
    return new RegExp(`${OPEN}(?:${body})${CLOSE}`, 'giu');
}

/**
 * Passive voice: an auxiliary, then optionally an adverb, then a past
 * participle. Composed rather than listed, because the participles on their own
 * are said, thought, made, found, held, left, put, run, set, told - most of the
 * verbs a novel is built from. See the note in the JSON.
 */
function buildPassive(auxiliaries, participles) {
    const aux = [...auxiliaries].sort((a, b) => b.length - a.length).map(escapeRegex).join('|');
    const part = [...participles].sort((a, b) => b.length - a.length).map(escapeRegex).join('|');
    return new RegExp(`${OPEN}(?:${aux})\\s+(?:\\w+ly\\s+)?(?:${part})${CLOSE}`, 'giu');
}

export function compile(data, options = {}) {
    const skip = new Set((options.skipTerms || []).map(t => t.toLowerCase()));
    const categories = [];

    for (const [id, category] of Object.entries(data.categories)) {
        if (category.highlight === false) continue;

        if (category.match === 'composed') {
            categories.push({
                id, label: category.label, kind: 'composed',
                regex: buildPassive(category.auxiliaries, category.participles),
                meta: new Map()
            });
            continue;
        }

        if (category.match === 'regex') {
            categories.push({
                id, label: category.label, kind: 'regex',
                patterns: category.terms.map(t => ({
                    name: t.name, reason: t.reason, regex: new RegExp(t.pattern, 'giu')
                }))
            });
            continue;
        }

        // Literal. Terms are either bare strings or objects carrying a reason
        // or a suggested replacement; both end up in the same lookup so a hit
        // can explain itself without a second pass over the data.
        const meta = new Map();
        const terms = [];
        for (const entry of category.terms) {
            const term = typeof entry === 'string' ? entry : entry.term;
            if (skip.has(term.toLowerCase())) continue;
            terms.push(term);
            if (typeof entry !== 'string') meta.set(term.toLowerCase(), entry);
        }
        if (!terms.length) continue;

        categories.push({ id, label: category.label, kind: 'literal', regex: buildAlternation(terms), meta });
    }

    return categories;
}

/**
 * Scan text, return hits sorted by position with overlaps resolved.
 *
 * @param {string} text
 * @param {Array} compiled   output of compile()
 * @param {object} options   { only: Set<categoryId> }
 * @returns {Array<{from, to, category, label, text, reason, suggestion}>}
 */
export function scan(text, compiled, options = {}) {
    const body = String(text || '');
    if (!body) return [];

    const only = options.only instanceof Set ? options.only : null;
    const hits = [];

    for (const category of compiled) {
        if (only && !only.has(category.id)) continue;

        if (category.kind === 'regex') {
            for (const pattern of category.patterns) {
                collect(body, pattern.regex, hits, category, () => ({ reason: pattern.reason, rule: pattern.name }));
            }
            continue;
        }

        collect(body, category.regex, hits, category, (matched) => {
            const entry = category.meta.get(matched.toLowerCase().replace(/\s+/g, ' '));
            return entry ? { reason: entry.reason, suggestion: entry.suggestion } : {};
        });
    }

    return resolveOverlaps(hits);
}

function collect(body, regex, hits, category, describe) {
    regex.lastIndex = 0;
    let match;
    // A zero-length match would spin forever; no pattern here can produce one,
    // but the guard costs nothing and a hung editor is unrecoverable.
    while ((match = regex.exec(body)) !== null) {
        if (match[0].length === 0) { regex.lastIndex += 1; continue; }
        hits.push({
            from: match.index,
            to: match.index + match[0].length,
            category: category.id,
            label: category.label,
            text: match[0],
            ...describe(match[0])
        });
    }
}

/**
 * One span, one flag.
 *
 * "in the realm of" is an AI phrase AND contains the AI-vocabulary word
 * "realm"; "it's worth noting that" is an AI phrase and a hedge. Left alone
 * they paint two overlapping underlines on the same words, which reads as two
 * problems where there is one. The longest match wins, and on a tie the one
 * found first does - so the writer is told about the phrase, not the fragment.
 */
function resolveOverlaps(hits) {
    hits.sort((a, b) => a.from - b.from || (b.to - b.from) - (a.to - a.from));

    const kept = [];
    let lastEnd = -1;
    for (const hit of hits) {
        if (hit.from < lastEnd) continue;
        kept.push(hit);
        lastEnd = hit.to;
    }
    return kept;
}

/** Counts per category, for a summary line that does not need the hits. */
export function summarise(hits) {
    const counts = new Map();
    for (const hit of hits) counts.set(hit.category, (counts.get(hit.category) || 0) + 1);
    return counts;
}
