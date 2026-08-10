const GeminiClient = require('../gemini/GeminiClient');

/**
 * SuggestionService
 *
 * Asks Gemini for concrete edits — "replace this exact text with that" — rather
 * than the prose critique CriticEngine produces. The difference matters: a
 * critique is read by a human, but a suggestion is *applied to the manuscript*,
 * so a suggestion that cannot be located exactly is worse than no suggestion at
 * all.
 *
 * That drives the two rules enforced in verify():
 *   - `original` must appear in the text verbatim. Models paraphrase the line
 *     they are proposing to change.
 *   - `original` must appear exactly ONCE. A fragment occurring twice cannot be
 *     applied safely: a naive replace would hit the wrong sentence and silently
 *     corrupt prose the writer never reviewed.
 *
 * VERIFY STAYS, EVEN THOUGH THE MODEL IS BETTER NOW. This ran against a local
 * Gemma 3 4B, and verify() was written for how freely a 4B invents a quote.
 * Gemini paraphrases less often, not never, and the cost of the one that slips
 * through is corrupted prose in a file the writer trusts. The check is cheap.
 *
 * What did go with the local model is the chunking. A 4B ran on an 8192-token
 * context, so a chapter had to be cut into 9000-character pieces and analysed
 * blind to everything outside each one — which lost exactly the cross-paragraph
 * repetition a line editor is looking for. Gemini takes the chapter whole.
 *
 * Spelling is deliberately out of scope — SpellService owns that, exactly and
 * instantly — and so is punctuation, which MechanicsService now does with
 * regex. Narrowing this to judgment calls is what keeps it worth the wait.
 */

// Shortest span worth offering as a line edit. See the note in verify().
const MIN_SPAN_CHARS = 12;

const SUGGESTION_SCHEMA = {
    type: 'object',
    properties: {
        suggestions: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    original: { type: 'string' },
                    replacement: { type: 'string' },
                    reason: { type: 'string' }
                },
                required: ['original', 'replacement', 'reason']
            }
        }
    },
    required: ['suggestions']
};

const INSTRUCTIONS =
    'You are a line editor proposing specific edits to a passage of prose.\n\n' +
    'Propose edits that make the prose stronger: cut filler, replace filter words ' +
    '("he felt", "she saw", "it seemed") with direct action, replace weak verb-plus-adverb ' +
    'pairs with one strong verb, break up unintentional repetition, and tighten sentences ' +
    'that carry less than their length.\n\n' +
    'Rules:\n' +
    '- Do NOT report spelling mistakes. Those are handled elsewhere.\n' +
    '- Do NOT report punctuation, capitalisation or grammar. Those are handled elsewhere.\n' +
    '- "original" must be copied EXACTLY from the passage, character for character. Never paraphrase it.\n' +
    '- Choose an "original" span that appears only once in the passage.\n' +
    '- "replacement" is the full text that should stand in its place.\n' +
    '- Preserve the author\'s voice. Do not make the prose more formal or more generic. ' +
    'Deliberate fragments, dialect and invented words are choices, not errors.\n' +
    '- Keep "reason" under 20 words.\n' +
    '- Only propose an edit that clearly improves the line. Strong prose needs few; an empty list is a valid answer.';

class SuggestionService {
    /** Whether this can run at all — the AI is opt-in. See GeminiClient. */
    availability() {
        return GeminiClient.availability();
    }

    /**
     * Keep only suggestions that can be applied safely, and locate each one in
     * the document.
     *
     * Searching the document directly makes the offset correct by construction
     * and makes uniqueness a document-wide guarantee — which is what an "apply"
     * button actually needs.
     *
     * @param {Array}  raw       Suggestions as returned by the model.
     * @param {string} document  The complete text being scanned.
     */
    verify(raw, document) {
        const kept = [];
        const claimed = new Set();

        for (const item of raw) {
            const original = String(item.original || '').trim();
            const replacement = String(item.replacement ?? '').trim();
            const reason = String(item.reason || '').trim();

            if (!original || !reason) continue;
            if (original === replacement) continue;
            if (claimed.has(original)) continue;

            // Safety comes from the uniqueness check below, not from length.
            // This floor is a quality filter: these are phrase-level line
            // edits, and the filter-word and weak-verb constructions worth
            // rewriting ("it seemed to", "he felt a chill") all run past a
            // dozen characters. Anything shorter is the model latching onto a
            // single word, which reads as noise in the suggestion list.
            if (original.length < MIN_SPAN_CHARS) continue;

            const first = document.indexOf(original);
            if (first === -1) continue;                                  // invented
            if (document.indexOf(original, first + 1) !== -1) continue;  // ambiguous

            claimed.add(original);
            kept.push({
                original,
                replacement,
                reason,
                offset: first,
                length: original.length
            });
        }
        return kept;
    }

    /**
     * @param {string} text
     * @returns {Promise<{ suggestions: Array, model: string }>}
     */
    async suggest(text) {
        const available = await this.availability();
        if (!available.ok) throw new Error(available.reason);

        const body = String(text || '');
        if (!body.trim()) return { suggestions: [], model: null };

        const { model, modelName } = await GeminiClient.getModel({
            // Gemini's own structured-output mode. This replaced llama-server's
            // json_schema grammar and does the same job: unparseable output
            // becomes impossible rather than something to defend against.
            responseMimeType: 'application/json',
            responseSchema: SUGGESTION_SCHEMA,
            temperature: 0.2
        });

        console.log(`[SuggestionService] Asking ${modelName} for edits across ${body.length} characters...`);

        const result = await model.generateContent(`${INSTRUCTIONS}\n\nPASSAGE:\n\n${body}`);
        const response = await result.response;

        let raw;
        try {
            raw = JSON.parse(response.text()).suggestions;
        } catch (err) {
            console.error('[SuggestionService] Model returned unparseable output:', err.message);
            throw new Error('The model returned something that could not be read as edits. Try again.');
        }
        if (!Array.isArray(raw)) raw = [];

        const suggestions = this.verify(raw, body);
        if (raw.length !== suggestions.length) {
            console.log(`[SuggestionService] Dropped ${raw.length - suggestions.length} unusable suggestion(s).`);
        }

        suggestions.sort((a, b) => a.offset - b.offset);
        console.log(`[SuggestionService] ${suggestions.length} applicable suggestion(s).`);
        return { suggestions, model: modelName };
    }
}

module.exports = new SuggestionService();
