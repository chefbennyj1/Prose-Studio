const GeminiClient = require('./GeminiClient');
const { getLens } = require('../critic/CriticLenses');

/**
 * GeminiCriticService — the critic.
 *
 * NOTE: this sends the passage to Google. It runs only when the writer has
 * switched AI on in Settings and supplied a key; GeminiClient owns that gate
 * and the rail hides this feature entirely until it is open.
 *
 * It was once the alternative to a local Gemma 3 4B. What it buys over that is
 * not only a stronger model but a context window that swallows a whole chapter
 * — the local path judged 9000 characters at a time, which is no way to assess
 * pacing or structure.
 */
class GeminiCriticService {
    /** Whether the AI is switched on and reachable. */
    availability() {
        return GeminiClient.availability();
    }

    /**
     * @param {string} text  The prose to analyse.
     * @param {object} opts  { lens }
     * @returns {Promise<string>} Markdown critique.
     */
    async analyze(text, opts = {}) {
        const lens = getLens(opts.lens);
        const body = (text || '').trim();
        if (!body) throw new Error('There is no text to critique.');

        try {
            const { model, modelName } = await GeminiClient.getModel();

            const instructions =
                `You are a working fiction editor reviewing a passage of prose.\n\n` +
                `${lens.focus}\n\n` +
                `Rules:\n` +
                `- Quote the exact text you are commenting on, word for word. Never paraphrase a quote.\n` +
                `- Be direct and specific. No filler, no encouragement padding.\n` +
                `- Only report genuine problems. A strong passage legitimately has few.\n` +
                `- Open with a short "What is working" section, then "Findings".\n` +
                `- Format the response in Markdown.`;

            console.log(`[GeminiCritic] Lens "${lens.id}": analysing with ${modelName}...`);
            const result = await model.generateContent(`${instructions}\n\nPASSAGE:\n\n${body}`);
            const response = await result.response;

            return `# ${lens.label} — ${modelName}\n\n_${lens.blurb}_\n\n${response.text()}`;
        } catch (err) {
            console.error(`[GeminiCritic] Analysis Error:`, err.message);
            throw err;
        }
    }
}

module.exports = new GeminiCriticService();
