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
 * been supplied. The checkbox is the only thing that grants it: a key in the
 * environment supplies the key and grants nothing. That replaced an older arrangement where a local model was the
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
        /*
         * CONSENT LIVES IN SETTINGS AND NOWHERE ELSE.
         *
         * This used to read `if (!enabled && !process.env.GEMINI_API_KEY)`,
         * which meant a key in the environment satisfied the gate on its own:
         * with GEMINI_API_KEY set, switching the AI OFF in Settings did not
         * switch it off. The checkbox was decorative on any machine with an
         * env key, and the header above this class described a promise the
         * code did not keep.
         *
         * A key is not consent. Supplying one says "here is how to reach
         * Gemini if I ask you to", not "send my novel". Only the checkbox says
         * the second thing, so only the checkbox is read here. getApiKey()
         * still falls back to the environment, because WHERE the key comes
         * from is a different question from WHETHER to use it.
         */
        let settings;
        try {
            settings = await GlobalSettings.findOne({ key: "main" });
        } catch (err) {
            /*
             * Fail CLOSED, and note that this is the opposite of what
             * ReviewMenu.drawAiRows does on a failed request - deliberately.
             * There, an unreachable server hides half the Review menu with no
             * explanation, so it fails open and lets the feature report its
             * own error. Here the question is whether the writer agreed to
             * send their manuscript to Google, and an unreadable answer to
             * that is not a yes.
             */
            console.error('[Gemini] Could not read the AI settings:', err.message);
            return { ok: false, reason: 'Your AI settings could not be read, so the AI is off until they can be. Nothing has been sent.' };
        }

        if (!settings?.critic?.enabled) {
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

    /**
     * Turn a Gemini SDK error into a sentence a novelist can act on.
     *
     * The same job BackupService.explainPushError does for git, and for the
     * same reason. Ben watched a raw SDK error for hours - a URL, a bracketed
     * status and a paragraph of Google's prose - and reasonably concluded the
     * service was down. It was not: the free tier allows 20 requests a day per
     * model, and he had spent them. Nothing on screen said so, and "try again
     * later" is actively misleading for a quota that resets tomorrow.
     *
     * The distinction that matters to the writer is only ever: is this me, is
     * it my key, or is it Google - and is waiting going to help.
     */
    explain(err) {
        const text = String(err?.message || err || '');
        const status = (/\[(\d{3})\s/.exec(text) || [])[1];

        // A daily cap is not a spike, and must not be described as one.
        if (/PerDay/i.test(text) || /quota/i.test(text) && /free_tier/i.test(text)) {
            const limit = (/limit:\s*(\d+)/.exec(text) || [])[1];
            const model = (/model:\s*([\w.-]+)/.exec(text) || [])[1];
            return `Today's free Gemini allowance is used up${limit ? ` (${limit} requests a day` : ''}`
                + `${limit && model ? ` for ${model}` : ''}${limit ? ')' : ''}. `
                + 'It resets tomorrow. To keep going now, add billing to the Google project this key belongs to. '
                + 'Everything local — spelling, mechanics and the overuse count — still works.';
        }

        if (status === '429') {
            const wait = (/retry in ([\d.]+)s/i.exec(text) || [])[1];
            return `Gemini is rate-limiting this key${wait ? `; it asked to wait ${Math.ceil(Number(wait))} seconds` : ''}. Try again shortly.`;
        }

        if (status === '503' || /high demand|overloaded/i.test(text)) {
            return 'Gemini is busy and turned this request away. That is usually brief — try again in a minute.';
        }

        if (status === '400' && /API key not valid/i.test(text)) {
            return 'That Gemini API key was rejected. Check it in Settings.';
        }

        if (status === '404') {
            return `Gemini has no model called "${text.match(/models\/([\w.-]+)/)?.[1] || 'that'}" for this key. Pick another in Settings.`;
        }

        if (/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(text)) {
            return 'Could not reach Gemini. Check the connection and try again.';
        }

        return text;
    }
}

module.exports = new GeminiClient();
