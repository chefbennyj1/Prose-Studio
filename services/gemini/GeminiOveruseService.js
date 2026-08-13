// services/gemini/GeminiOveruseService.js

const GeminiClient = require('./GeminiClient');

/**
 * GeminiOveruseService
 *
 * The judgment half of the overused-word check. It is NOT given the manuscript
 * and it is NOT asked to count anything.
 *
 * That division is the whole design. OveruseService has already counted, over
 * the real text, exhaustively - so by the time this runs, "how many" is a
 * settled fact and no longer anybody's opinion. Asking a model to count long
 * text produces confident, plausible, wrong numbers, and a wrong count is worse
 * than no count because nothing in the panel reveals it. What a model is
 * genuinely better at than any regex is the question the count cannot answer:
 * of these thirty-four, which ones are doing work?
 *
 * So it receives the tally plus a sample of real sentences and returns a
 * verdict per word. If it hallucinates here the damage is bounded - a wrong
 * verdict is an opinion the writer can disagree with, next to a number that is
 * still correct.
 */

const VERDICT_SCHEMA = {
    type: 'object',
    properties: {
        verdicts: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    word: { type: 'string' },
                    verdict: { type: 'string', enum: ['tic', 'watch', 'fine'] },
                    comment: { type: 'string' }
                },
                required: ['word', 'verdict', 'comment']
            }
        },
        summary: { type: 'string' }
    },
    required: ['verdicts', 'summary']
};

const INSTRUCTIONS = [
    'You are a developmental editor looking at word-frequency data for one novel.',
    '',
    'The counts are EXACT. They were produced by scanning the manuscript, not by',
    'estimating. Do not dispute them, recount them, or say "approximately".',
    '',
    'For each word decide whether its use is a habit worth the author knowing about:',
    '  "tic"   - clearly overused; the rate and the samples both point at a reflex',
    '  "watch" - defensible, but dense enough to be worth a pass',
    '  "fine"  - normal usage for a novel of this length',
    '',
    'Judge on the SAMPLES, not the number alone. A word can be frequent and earning',
    'it every time. Say which of the sample sentences would survive the cut and which',
    'would not.',
    '',
    'Rules:',
    '- Narration and dialogue counts are given separately. A character who talks in',
    '  absolutes is characterisation, not a flaw - weigh dialogue far more leniently,',
    '  and say so when the count is mostly dialogue.',
    '- Never tell the author to eliminate a word. These are all legitimate English',
    '  words that good novels use deliberately.',
    '- comment is one or two sentences, specific to this book. No generic advice',
    '  about adverbs, and no restating the number back.',
    '- The summary is at most three sentences on the pattern across the whole list -',
    '  what it suggests about the prose, not a list of the words again.'
].join('\n');

/** Words sent for judgment. Beyond this the tail is noise. */
const MAX_WORDS = 18;

/** Sample sentences per word. Enough to see a pattern, few enough to stay cheap. */
const MAX_SAMPLES = 6;

class GeminiOveruseService {
    availability() {
        return GeminiClient.availability();
    }

    /**
     * @param {object} report  the output of OveruseService.scan
     * @returns {Promise<{ verdicts: Array, summary: string, model: string }>}
     */
    async judge(report) {
        const available = await this.availability();
        if (!available.ok) throw new Error(available.reason);

        const words = (report.words || []).slice(0, MAX_WORDS);
        if (!words.length) return { verdicts: [], summary: '', model: null };

        const { model, modelName } = await GeminiClient.getModel({
            responseMimeType: 'application/json',
            responseSchema: VERDICT_SCHEMA,
            temperature: 0.3
        });

        const brief = [
            `MANUSCRIPT: ${report.stats.words.toLocaleString()} words across ${report.stats.chapters} chapter(s).`,
            '',
            ...words.map(row => [
                `WORD: ${row.word}`,
                `  uses: ${row.total} (${row.narration} narration, ${row.dialogue} dialogue)`,
                `  rate: ${row.per10k} per 10,000 words`,
                ...sampleLines(row)
            ].join('\n'))
        ].join('\n\n');

        console.log(`[GeminiOveruseService] Asking ${modelName} to judge ${words.length} word(s)...`);

        const result = await model.generateContent(`${INSTRUCTIONS}\n\nDATA:\n\n${brief}`);
        const response = await result.response;

        let parsed;
        try {
            parsed = JSON.parse(response.text());
        } catch (err) {
            console.error('[GeminiOveruseService] Unparseable output:', err.message);
            throw new Error('The model returned something that could not be read. Try again.');
        }

        /*
         * Keep only verdicts about words that were actually counted.
         *
         * The model is told the list but nothing stops it inventing a row, and
         * an invented word would appear in the panel beside real counts with
         * nothing to mark it as different. Cheaper to drop it than to explain it.
         */
        const known = new Map(words.map(row => [row.word.toLowerCase(), row]));
        const verdicts = (parsed.verdicts || [])
            .filter(entry => entry && known.has(String(entry.word || '').toLowerCase()))
            .map(entry => ({
                word: known.get(entry.word.toLowerCase()).word,
                verdict: ['tic', 'watch', 'fine'].includes(entry.verdict) ? entry.verdict : 'watch',
                comment: String(entry.comment || '').trim()
            }));

        const dropped = (parsed.verdicts || []).length - verdicts.length;
        if (dropped > 0) console.log(`[GeminiOveruseService] Dropped ${dropped} verdict(s) for words that were never counted.`);

        return { verdicts, summary: String(parsed.summary || '').trim(), model: modelName };
    }
}

/**
 * Narration samples first.
 *
 * The dialogue instances are the ones least likely to be a problem, so filling
 * the sample budget with them would show the model the least useful evidence
 * and invite a lenient verdict on a genuine narration habit.
 */
function sampleLines(row) {
    const occurrences = row.occurrences || [];
    const narration = occurrences.filter(o => !o.inQuote);
    const dialogue = occurrences.filter(o => o.inQuote);
    const picked = [...narration, ...dialogue].slice(0, MAX_SAMPLES);

    if (!picked.length) return [];
    return [
        '  samples:',
        ...picked.map(o => `    - [${o.inQuote ? 'dialogue' : 'narration'}] ${o.context}`)
    ];
}

module.exports = new GeminiOveruseService();
