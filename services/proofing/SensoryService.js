// services/proofing/SensoryService.js

const { SENSES, CONTEXTUAL, sensesFor } = require('./SensoryLexicon');
const { stripMarkdown } = require('../narrator/TextPlan');
const { lineIndex, lineAt, splitParagraphs, findQuotes, makeInQuote } = require('./MechanicsText');

/**
 * SensoryService
 *
 * Which of the five senses a chapter is written through, and - the part that
 * matters - where a sense goes missing for long enough that a reader stops
 * being anywhere.
 *
 * Local, exact, no model. The offsets are where the word was found rather than
 * where anything claimed it was, the same contract MechanicsService and
 * OveruseService keep.
 *
 * THE NUMBERS ARE NOT A TARGET.
 *
 * Most drafts are eighty per cent sight, and the naive reading of that is
 * "add smells". It is wrong. Taste is genuinely rare in fiction that is not
 * about food, touch belongs to weather and violence and intimacy, and a scene
 * of two people talking across a desk has no business smelling of anything.
 * A balanced chapter is not the goal and this does not report one.
 *
 * What it reports is RUNS: stretches of narration where a sense that the
 * chapter otherwise uses has gone quiet. "Eleven paragraphs with nothing heard"
 * is a note a writer can act on, and it survives a lexicon's false positives -
 * which a per-sentence verdict would not.
 *
 * Dialogue is excluded from the run detection, deliberately. A page of pure
 * speech is not a sensory desert, it is a conversation, and flagging it would
 * train the writer to ignore the whole panel.
 */

/**
 * How many consecutive NARRATION paragraphs without a sense before it is worth
 * mentioning.
 *
 * Six is about a page and a half of manuscript - long enough that a reader has
 * genuinely lost that channel, short enough to still be fixable in one pass.
 * Below four this fires constantly on ordinary prose and becomes noise.
 */
const RUN_THRESHOLD = 6;

/**
 * A sense has to be present in the chapter at all before its absence is worth
 * reporting. A chapter with no taste in it anywhere is almost every chapter
 * ever written; a chapter that tastes of something twice and then never again
 * is a chapter that dropped a thread.
 */
const MIN_USES_TO_TRACK = 3;

class SensoryService {

    /** The senses, for a UI that wants to label them. */
    describe() {
        return {
            senses: Object.entries(SENSES).map(([id, s]) => ({ id, label: s.label }))
        };
    }

    /**
     * @param {string} text  one chapter, Markdown
     * @returns {object} { senses, paragraphs, findings, stats }
     */
    scan(text) {
        const clean = stripMarkdown(String(text || ''));
        if (!clean.trim()) {
            return { senses: {}, paragraphs: [], findings: [], stats: { words: 0, paragraphs: 0 } };
        }

        const starts = lineIndex(clean);
        const spans = splitParagraphs(clean);
        const inQuote = makeInQuote(findQuotes(clean, spans));

        const totals = {};
        for (const id of Object.keys(SENSES)) {
            totals[id] = { id, label: SENSES[id].label, total: 0, narration: 0, dialogue: 0, hits: [] };
        }

        const paragraphs = [];
        let words = 0;

        for (const span of spans) {
            const body = clean.slice(span.from, span.to);
            if (!body.trim()) continue;

            const present = new Set();
            let paragraphWords = 0;
            // A paragraph counts as dialogue if it is mostly spoken; the run
            // detection skips those.
            let quoted = 0;
            let total = 0;

            const pattern = /[\p{L}][\p{L}'’-]*/gu;
            let match;
            while ((match = pattern.exec(body)) !== null) {
                paragraphWords += 1;
                total += 1;

                const offset = span.from + match.index;
                const isQuoted = inQuote(offset);
                if (isQuoted) quoted += 1;

                const word = match[0].toLowerCase().replace(/[’']s$/, '');
                const senses = sensesFor(word);
                if (!senses.length) continue;

                // "She felt afraid" is not touch. See CONTEXTUAL.
                const gate = CONTEXTUAL[word];
                if (gate && !gate(nextWord(body, match.index + match[0].length))) continue;

                for (const id of senses) {
                    present.add(id);
                    totals[id].total += 1;
                    if (isQuoted) totals[id].dialogue += 1; else totals[id].narration += 1;
                    if (totals[id].hits.length < 60) {
                        totals[id].hits.push({
                            word, offset,
                            line: lineAt(starts, offset),
                            inQuote: isQuoted
                        });
                    }
                }
            }

            words += paragraphWords;
            paragraphs.push({
                index: paragraphs.length,
                from: span.from,
                to: span.to,
                line: lineAt(starts, span.from),
                words: paragraphWords,
                // Half or more of the words inside quotes reads as a spoken
                // paragraph. An action beat with one line of speech does not.
                isDialogue: total > 0 && quoted / total >= 0.5,
                senses: [...present],
                opening: body.trim().slice(0, 70)
            });
        }

        return {
            senses: totals,
            paragraphs,
            findings: this.#runs(paragraphs, totals),
            stats: {
                words,
                paragraphs: paragraphs.length,
                per1k: rates(totals, words)
            }
        };
    }

    /**
     * Stretches of narration with a sense missing.
     *
     * Only for senses the chapter actually uses - see MIN_USES_TO_TRACK. And
     * only across narration: a run of dialogue paragraphs does not break a
     * stretch and does not extend one, because speech is neither the presence
     * nor the absence of sensory writing.
     */
    #runs(paragraphs, totals) {
        const tracked = Object.values(totals)
            .filter(sense => sense.total >= MIN_USES_TO_TRACK)
            .map(sense => sense.id);

        const findings = [];

        for (const id of tracked) {
            let run = [];

            const close = () => {
                if (run.length >= RUN_THRESHOLD) {
                    findings.push({
                        sense: id,
                        label: SENSES[id].label,
                        paragraphs: run.length,
                        fromLine: run[0].line,
                        toLine: run[run.length - 1].line,
                        from: run[0].from,
                        to: run[run.length - 1].to,
                        opening: run[0].opening
                    });
                }
                run = [];
            };

            for (const paragraph of paragraphs) {
                if (paragraph.isDialogue) continue;          // neither breaks nor extends
                if (paragraph.senses.includes(id)) close();
                else run.push(paragraph);
            }
            close();
        }

        // Longest first: the eleven-paragraph gap matters more than the six.
        return findings.sort((a, b) => b.paragraphs - a.paragraphs);
    }
}

/** The next word after an offset, lowercased. '' at the end. */
function nextWord(text, from) {
    const match = /^[\s"'’”)]*([\p{L}']+)/u.exec(text.slice(from, from + 40));
    return match ? match[1].toLowerCase() : '';
}

/** Uses per 1,000 words, so chapters of different lengths compare. */
function rates(totals, words) {
    const out = {};
    for (const [id, sense] of Object.entries(totals)) {
        out[id] = words ? Math.round((sense.total / words) * 1000 * 10) / 10 : 0;
    }
    return out;
}

module.exports = new SensoryService();
