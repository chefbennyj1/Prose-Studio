const { GoogleGenerativeAI } = require("@google/generative-ai");
const GlobalSettings = require("../../models/GlobalSettings");
const { decrypt } = require("../../utils/encryption");
const { getLens } = require("../critic/CriticLenses");

/**
 * GeminiCriticService — the cloud critic path.
 *
 * NOTE: this sends the manuscript to Google. It is deliberately not the
 * default; CriticEngine defaults to the local path and this runs only when the
 * writer explicitly picks "cloud". It buys a stronger model and a context
 * window that swallows a whole chapter, at the cost of the text leaving the
 * machine.
 */
class GeminiCriticService {
    async getClient() {
        let apiKey = process.env.GEMINI_API_KEY;
        try {
            const settings = await GlobalSettings.findOne({ key: "main" });
            if (settings && settings.critic && settings.critic.apiKey) {
                const decrypted = decrypt(settings.critic.apiKey);
                if (decrypted) apiKey = decrypted;
            }
        } catch (e) {
            console.error("[GeminiCritic] Failed to fetch API key:", e.message);
        }

        if (!apiKey) throw new Error("Gemini API Key is missing.");
        return new GoogleGenerativeAI(apiKey);
    }

    get engineName() {
        return 'cloud';
    }

    availability() {
        return { ok: true };
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
            const genAI = await this.getClient();
            const settings = await GlobalSettings.findOne({ key: "main" });
            const targetModel = (settings?.critic?.modelName) || "gemini-flash-latest";

            const model = genAI.getGenerativeModel({ model: targetModel });

            const instructions =
                `You are a working fiction editor reviewing a passage of prose.\n\n` +
                `${lens.focus}\n\n` +
                `Rules:\n` +
                `- Quote the exact text you are commenting on, word for word. Never paraphrase a quote.\n` +
                `- Be direct and specific. No filler, no encouragement padding.\n` +
                `- Only report genuine problems. A strong passage legitimately has few.\n` +
                `- Open with a short "What is working" section, then "Findings".\n` +
                `- Format the response in Markdown.`;

            const prompt = `${instructions}\n\nPASSAGE:\n\n${body}`;

            console.log(`[GeminiCritic] Lens "${lens.id}": analysing with ${targetModel}...`);
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();

            return `# ${lens.label} — cloud (${targetModel})\n\n_${lens.blurb}_\n\n${text}`;
        } catch (err) {
            console.error(`[GeminiCritic] Analysis Error:`, err.message);
            throw err;
        }
    }
}

module.exports = new GeminiCriticService();
