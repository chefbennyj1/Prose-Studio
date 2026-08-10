const { GoogleGenerativeAI } = require("@google/generative-ai");
const GlobalSettings = require("../../models/GlobalSettings");
const { decrypt } = require("../../utils/encryption");

/**
 * GeminiClient
 *
 * One place that knows how to reach Gemini, and one place that knows whether
 * the writer has agreed to use it at all.
 *
 * THE AI IS OPT-IN AND THIS IS THE GATE. Nothing in the Prose Engine talks to
 * Google unless `critic.enabled` has been switched on in Settings and a key has
 * been supplied. That replaced an older arrangement where a local model was the
 * default and the cloud was the deliberate exception; the local models are gone
 * now, so the opt-in moved from "which engine answers" to "is there an AI at
 * all". The features that depend on it — Critique and Line edits — are hidden
 * from the rail entirely until this reports available, rather than being shown
 * and then failing.
 *
 * What still runs with the AI switched off is the point of that arrangement:
 * spelling, the whole mechanics scanner, and the narrator are local, instant
 * and free, and they are the majority of what the editor does.
 */

class GeminiClient {
    /**
     * The key, from settings first and the environment second.
     * @returns {Promise<string|null>}
     */
    async getApiKey() {
        try {
            const settings = await GlobalSettings.findOne({ key: "main" });
            if (settings?.critic?.apiKey) {
                const decrypted = decrypt(settings.critic.apiKey);
                if (decrypted) return decrypted;
            }
        } catch (err) {
            console.error("[Gemini] Could not read the stored API key:", err.message);
        }
        return process.env.GEMINI_API_KEY || null;
    }

    /**
     * Is the cloud AI switched on AND reachable?
     *
     * Both halves matter and they fail differently, so they are reported
     * separately: a writer who has not enabled the AI should be told it is off,
     * not that a key is missing.
     *
     * @returns {Promise<{ok: boolean, reason: string|null}>}
     */
    async availability() {
        let enabled = false;
        try {
            const settings = await GlobalSettings.findOne({ key: "main" });
            enabled = !!settings?.critic?.enabled;
        } catch (err) {
            // No database yet, during setup. An env key still counts.
            enabled = !!process.env.GEMINI_API_KEY;
        }

        if (!enabled && !process.env.GEMINI_API_KEY) {
            return { ok: false, reason: 'AI features are switched off. Turn them on in Settings to use Critique and Line edits.' };
        }

        const key = await this.getApiKey();
        if (!key) {
            return { ok: false, reason: 'No Gemini API key has been saved. Add one in Settings.' };
        }

        return { ok: true, reason: null };
    }

    /** Which model the writer picked, or the default. */
    async getModelName() {
        try {
            const settings = await GlobalSettings.findOne({ key: "main" });
            return settings?.critic?.modelName || 'gemini-flash-latest';
        } catch {
            return 'gemini-flash-latest';
        }
    }

    /**
     * A ready model handle.
     *
     * @param {object} generationConfig  Passed straight to Gemini. The
     *        suggestions path uses this to demand a JSON schema, which is what
     *        replaced the llama-server grammar that used to make a 4B's output
     *        parseable.
     * @returns {Promise<{model: object, modelName: string}>}
     */
    async getModel(generationConfig = undefined) {
        const available = await this.availability();
        if (!available.ok) throw new Error(available.reason);

        const key = await this.getApiKey();
        const modelName = await this.getModelName();

        const genAI = new GoogleGenerativeAI(key);
        const model = genAI.getGenerativeModel({ model: modelName, generationConfig });

        return { model, modelName };
    }
}

module.exports = new GeminiClient();
