const GeminiCriticService = require('../gemini/GeminiCriticService');
const { listLenses, DEFAULT_LENS } = require('./CriticLenses');

/**
 * CriticEngine
 *
 * Runs a critique under one of the lenses in CriticLenses.
 *
 * THIS USED TO CHOOSE BETWEEN ENGINES and no longer does. A local Gemma 3 4B
 * was the default and the cloud was opt-in per run, on the reasoning that
 * posting a manuscript to Google should be a deliberate act. That arrangement
 * is gone, and it is worth being honest about why rather than quietly deleting
 * the comment that promised it:
 *
 *   - The local model needed an 8192-token context, so a chapter was cut into
 *     9000-character pieces and each was judged blind to the rest. Structural
 *     critique of a chapter you can only see a fifth of is not structural
 *     critique.
 *   - Every failure mode the editor had came from the engine around it: a model
 *     that took ~60s to wake, a two-minute wait for it, and the plugin
 *     lifecycle that started and stopped it.
 *   - A 4B needed grammar-constrained JSON and aggressive verification to
 *     produce anything usable at all.
 *
 * So the deliberate act moved rather than disappeared. It is no longer "which
 * engine answers this run" but "is there an AI here at all": nothing reaches
 * Google until the writer switches AI on in Settings and supplies a key, and
 * until they do, Critique and Line edits are not shown in the rail. See
 * GeminiClient, which owns that gate.
 *
 * The floor under that decision is what makes it fair. With the AI switched
 * off the editor still spell-checks against the story's own dictionary, runs
 * the whole mechanics scanner, and narrates — all locally, instantly, free, and
 * without a word of the manuscript leaving the machine.
 */

class CriticEngine {
    /**
     * Lens list for the UI, plus whether the AI can run at all, so the rail can
     * hide what it cannot offer instead of showing it and failing.
     */
    async describe() {
        const availability = await GeminiCriticService.availability();

        return {
            lenses: listLenses(),
            defaultLens: DEFAULT_LENS,
            ai: {
                ok: availability.ok,
                reason: availability.reason,
                label: 'Gemini',
                blurb: 'Sends the passage to Google. Nothing else in the editor does.'
            }
        };
    }

    /**
     * @param {string} text  The prose to analyse.
     * @param {object} opts  { lens }
     * @returns {Promise<{ lens: string, critique: string }>}
     */
    async analyze(text, opts = {}) {
        const lens = opts.lens || DEFAULT_LENS;

        console.log(`[CriticEngine] Running the "${lens}" lens.`);
        const critique = await GeminiCriticService.analyze(text, { lens });

        return { lens, critique };
    }
}

module.exports = new CriticEngine();
