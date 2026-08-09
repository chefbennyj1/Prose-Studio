const { RULES, GROUPS } = require('./MechanicsRules');
const {
    lineIndex, lineAt, splitParagraphs, splitSentences, findQuotes, makeInQuote
} = require('./MechanicsText');

/**
 * MechanicsService
 *
 * Runs the mechanics rules over a document and returns anchored findings.
 *
 * The contract this has to honour is the one SuggestionService already
 * discovered the hard way: a finding is not read, it is *applied*, so a span
 * that cannot be located exactly is worse than no finding at all. Here that
 * comes free — the rules match against the document itself, so `offset` is
 * where the match was found rather than where a model claimed it was — and the
 * `quote` on every finding is sliced back out of the text by this service
 * rather than reported by the rule. If a rule miscounts, the quote it produces
 * is visibly wrong in the panel instead of quietly wrong in the manuscript.
 *
 * Nothing here calls a model, touches the network, or waits on a plugin. A
 * chapter scans in a few milliseconds, which is what makes it reasonable to
 * offer as something the writer runs whenever they like.
 */

const DEFAULTS = {
    longSentenceWords: 45,
    longParagraphWords: 250,
    openerRun: 3,
    disabled: []
};

/** How much text travels with a finding so the panel can show it in context. */
const CONTEXT_CHARS = 150;

class MechanicsService {
    /** Rule and group list for the UI's toggles. */
    describe() {
        return {
            groups: Object.entries(GROUPS).map(([id, label]) => ({ id, label })),
            rules: RULES.map(({ id, label, group, severity, blurb }) => ({ id, label, group, severity, blurb })),
            defaults: { ...DEFAULTS, disabled: [] }
        };
    }

    /**
     * @param {string} text
     * @param {object} opts  { longSentenceWords, longParagraphWords, openerRun, disabled: [ruleId] }
     * @returns {{ findings: Array, stats: object, counts: object }}
     */
    scan(text, opts = {}) {
        const body = String(text || '');
        const options = { ...DEFAULTS, ...opts };
        const disabled = new Set(options.disabled || []);

        if (!body.trim()) {
            return { findings: [], counts: emptyCounts(), stats: emptyStats() };
        }

        const starts = lineIndex(body);
        const paragraphs = splitParagraphs(body);
        const sentences = paragraphs.flatMap(p => splitSentences(body, p.start, p.end));
        const quotes = findQuotes(body, paragraphs);

        const ctx = {
            text: body,
            paragraphs,
            sentences,
            quotes,
            inQuote: makeInQuote(quotes),
            options
        };

        const findings = [];

        for (const rule of RULES) {
            if (disabled.has(rule.id)) continue;

            let raw;
            try {
                raw = rule.find(ctx) || [];
            } catch (err) {
                // One bad rule must not cost the writer the other twenty.
                console.error(`[Mechanics] Rule "${rule.id}" threw:`, err.message);
                continue;
            }

            for (const item of raw) {
                const finding = this.anchor(rule, item, body, starts);
                if (finding) findings.push(finding);
            }
        }

        return {
            findings: dedupe(findings),
            counts: count(findings),
            stats: measure(body, paragraphs, sentences, quotes)
        };
    }

    /**
     * Turn a rule's raw hit into a finding the editor can act on, or drop it.
     *
     * Everything rejected here is rejected because it could not be applied
     * safely or would do nothing: an offset outside the document, a zero-length
     * span, or a "replacement" identical to the text it replaces.
     */
    anchor(rule, item, text, starts) {
        const offset = Number(item.offset);
        const length = Number(item.length);

        if (!Number.isInteger(offset) || offset < 0 || offset >= text.length) return null;
        if (!Number.isInteger(length) || length <= 0) return null;
        if (offset + length > text.length) return null;

        const quote = text.substr(offset, length);
        const replacement = item.replacement ?? null;
        if (replacement !== null && replacement === quote) return null;

        const from = Math.max(0, offset - Math.floor((CONTEXT_CHARS - length) / 2));
        const to = Math.min(text.length, from + CONTEXT_CHARS);

        return {
            rule: rule.id,
            label: rule.label,
            group: rule.group,
            severity: item.severity || rule.severity,
            message: item.message,
            offset,
            length,
            quote,
            replacement,
            line: lineAt(starts, offset),
            context: text.slice(from, to).replace(/\s+/g, ' ').trim(),
            // Where `quote` begins inside `context`, so the panel can mark it
            // without searching for a fragment that may occur twice.
            contextOffset: offset - from - (text.slice(from, offset).length - text.slice(from, offset).replace(/^\s+/, '').length)
        };
    }
}

/**
 * Two rules can legitimately land on the same span — a missing space after a
 * comma is also, to a different rule, a comma splice. The writer wants one row,
 * and wants the one that says a mistake rather than the one that says maybe.
 */
function dedupe(findings) {
    const byPosition = new Map();

    for (const finding of findings) {
        const key = `${finding.offset}:${finding.length}`;
        const existing = byPosition.get(key);

        if (!existing) {
            byPosition.set(key, finding);
            continue;
        }
        if (existing.severity === 'style' && finding.severity === 'error') {
            byPosition.set(key, finding);
        }
    }

    return [...byPosition.values()].sort((a, b) => a.offset - b.offset || a.length - b.length);
}

function count(findings) {
    const counts = emptyCounts();
    for (const finding of findings) {
        counts.total++;
        counts[finding.severity]++;
        counts.groups[finding.group] = (counts.groups[finding.group] || 0) + 1;
    }
    return counts;
}

function emptyCounts() {
    return { total: 0, error: 0, style: 0, groups: {} };
}

/**
 * The numbers the layout rules are judged against, reported alongside them so
 * the writer can see the shape of the chapter rather than only its faults.
 */
function measure(text, paragraphs, sentences, quotes) {
    const wordCount = (text.match(/[A-Za-z'’-]+/g) || []).length;
    const lengths = sentences.map(s => (s.text.match(/[A-Za-z'’-]+/g) || []).length).filter(Boolean);

    const dialogueChars = quotes.reduce((sum, q) => sum + (q.innerEnd - q.inner), 0);

    return {
        words: wordCount,
        sentences: sentences.length,
        paragraphs: paragraphs.length,
        averageSentence: lengths.length ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : 0,
        longestSentence: lengths.length ? Math.max(...lengths) : 0,
        averageParagraph: paragraphs.length ? Math.round(wordCount / paragraphs.length) : 0,
        // A rough but honest read on how much of the chapter is people talking.
        dialoguePercent: text.length ? Math.round((dialogueChars / text.length) * 100) : 0
    };
}

function emptyStats() {
    return {
        words: 0, sentences: 0, paragraphs: 0, averageSentence: 0,
        longestSentence: 0, averageParagraph: 0, dialoguePercent: 0
    };
}

module.exports = new MechanicsService();
