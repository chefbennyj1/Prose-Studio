const PluginLoader = require('../PluginLoader');

/**
 * SuggestionService
 *
 * Asks the local Gemma for concrete edits — "replace this exact text with
 * that" — rather than the prose critique the CriticEngine produces. The
 * difference matters: a critique is read by a human, but a suggestion is
 * *applied to the manuscript*, so a suggestion that cannot be located exactly
 * is worse than no suggestion at all.
 *
 * That drives the two rules enforced below:
 *   - `original` must appear in the text verbatim. A 4B will happily
 *     paraphrase the line it is proposing to change.
 *   - `original` must appear exactly ONCE in its chunk. A fragment occurring
 *     twice cannot be applied safely: a naive replace would hit the wrong
 *     sentence and silently corrupt prose the writer never reviewed.
 *
 * Spelling is deliberately out of scope — SpellService owns that, exactly and
 * instantly. Narrowing this prompt to judgment calls is what makes a 4B
 * useful here rather than noisy.
 */

const CHUNK_CHARS = 9000;

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

class SuggestionService {
    constructor() {
        this.port = Number(process.env.PORT) || 3000;
    }

    availability() {
        const plugin = PluginLoader.loadedPlugins['Local-Llm-Engine'];
        if (!plugin) {
            return { ok: false, reason: 'The Local-Llm-Engine plugin is not enabled. Enable it in the plugin manager and restart the server.' };
        }
        return { ok: true };
    }

    async waitForEngine(timeoutMs = 120000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const res = await fetch(`http://localhost:${this.port}/api/plugins/Local-Llm-Engine/status`);
                const data = await res.json();
                if (data.isRunning) return true;
            } catch (err) {
                // Not answering yet.
            }
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
        return false;
    }

    /** Gemma 3 has no system role: instructions lead the single user turn. */
    buildPrompt(instructions, content) {
        return `<start_of_turn>user\n${instructions}\n\n${content}<end_of_turn>\n<start_of_turn>model\n`;
    }

    /** Paragraph-boundary chunking; a chunk cut mid-sentence produces
     *  suggestions about the truncation instead of the writing. */
    chunkText(text) {
        const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
        const chunks = [];
        let current = '';

        for (const para of paragraphs) {
            if (current && current.length + para.length + 2 > CHUNK_CHARS) {
                chunks.push(current);
                current = para;
                continue;
            }
            current = current ? `${current}\n\n${para}` : para;
        }
        if (current) chunks.push(current);
        return chunks;
    }

    async executeLLM(promptString) {
        const response = await fetch(`http://localhost:${this.port}/api/plugins/Local-Llm-Engine/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt: promptString,
                n_predict: 800,
                temperature: 0.2,
                cache_prompt: true,
                json_schema: SUGGESTION_SCHEMA
            })
        });

        const data = await response.json();
        if (!data.ok) throw new Error(`Local engine error: ${data.message}`);

        try {
            const parsed = JSON.parse(data.content);
            return Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
        } catch (err) {
            console.error('[SuggestionService] Engine returned unparseable output:', data.content);
            return [];
        }
    }

    /**
     * Keep only suggestions that can be applied safely, and locate each one in
     * the FULL document rather than in its chunk.
     *
     * Chunks are rebuilt by rejoining paragraphs with "\n\n", which is not
     * necessarily how they were separated in the source, so a chunk-relative
     * offset can drift against the real document. A drifted offset applied to
     * the manuscript corrupts text the writer never reviewed. Searching the
     * document directly makes the offset correct by construction, and makes
     * uniqueness a document-wide guarantee — which is what an "apply" button
     * actually needs.
     *
     * @param {Array}  raw       Suggestions as returned by the model.
     * @param {string} document  The complete text being scanned.
     * @param {Set}    claimed   Spans already taken by an earlier chunk.
     */
    verify(raw, document, claimed = new Set()) {
        const kept = [];

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
     * @returns {Promise<{ suggestions: Array, chunks: number, failedChunks: number }>}
     */
    async suggest(text) {
        const available = this.availability();
        if (!available.ok) throw new Error(available.reason);

        const body = String(text || '');
        if (!body.trim()) return { suggestions: [], chunks: 0, failedChunks: 0 };

        if (!(await this.waitForEngine())) {
            throw new Error('The local LLM engine did not become ready. Start it from the dashboard and try again.');
        }

        const instructions =
            'You are a line editor proposing specific edits to a passage of prose.\n\n' +
            'Propose edits that make the prose stronger: cut filler, replace filter words ' +
            '("he felt", "she saw", "it seemed") with direct action, replace weak verb-plus-adverb ' +
            'pairs with one strong verb, break up unintentional repetition, and tighten sentences ' +
            'that carry less than their length.\n\n' +
            'Rules:\n' +
            '- Do NOT report spelling mistakes. Those are handled elsewhere.\n' +
            '- "original" must be copied EXACTLY from the passage, character for character. Never paraphrase it.\n' +
            '- Choose an "original" span that appears only once in the passage.\n' +
            '- "replacement" is the full text that should stand in its place.\n' +
            '- Preserve the author\'s voice. Do not make the prose more formal or more generic.\n' +
            '- Keep "reason" under 20 words.\n' +
            '- Only propose an edit that clearly improves the line. Strong prose needs few; an empty list is a valid answer.';

        const chunks = this.chunkText(body);
        console.log(`[SuggestionService] Scanning ${chunks.length} chunk(s) for edits...`);

        const suggestions = [];
        const claimed = new Set();
        let failedChunks = 0;

        for (let i = 0; i < chunks.length; i++) {
            const chunkText = chunks[i];
            console.log(`[SuggestionService] Chunk ${i + 1}/${chunks.length} (${chunkText.length} chars)...`);
            try {
                const raw = await this.executeLLM(this.buildPrompt(instructions, `PASSAGE:\n${chunkText}`));
                const verified = this.verify(raw, body, claimed);
                if (raw.length !== verified.length) {
                    console.log(`[SuggestionService] Dropped ${raw.length - verified.length} unusable suggestion(s) in chunk ${i + 1}.`);
                }
                suggestions.push(...verified);
            } catch (err) {
                console.error(`[SuggestionService] Chunk ${i + 1} failed:`, err.message);
                failedChunks++;
            }
        }

        suggestions.sort((a, b) => a.offset - b.offset);
        console.log(`[SuggestionService] ${suggestions.length} applicable suggestion(s).`);
        return { suggestions, chunks: chunks.length, failedChunks };
    }
}

module.exports = new SuggestionService();
