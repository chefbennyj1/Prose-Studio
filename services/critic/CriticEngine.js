const LocalCriticService = require('./LocalCriticService');
const GeminiCriticService = require('../gemini/GeminiCriticService');
const { listLenses, DEFAULT_LENS } = require('./CriticLenses');

/**
 * CriticEngine
 *
 * Picks the backend the critique runs on. Both engines expose the same
 * `analyze(text, { lens })` contract and share the lens definitions, so the
 * choice is genuinely about who answers, not about what gets asked.
 *
 * Local is the default and stays the default. Cloud is opt-in per run because
 * it posts the manuscript to Google; that is a decision the writer makes
 * deliberately, never one they fall into.
 */

const ENGINES = {
    local: LocalCriticService,
    cloud: GeminiCriticService
};

const DEFAULT_ENGINE = 'local';

class CriticEngine {
    resolve(engineId) {
        return ENGINES[engineId] ? engineId : DEFAULT_ENGINE;
    }

    /**
     * Engine list for the UI, each with a live availability check so the
     * dashboard can disable what cannot currently run and say why.
     */
    describe() {
        return {
            engines: [
                {
                    id: 'local',
                    label: 'Local (Gemma 3 4B)',
                    blurb: 'Runs on this machine. Your manuscript never leaves it.',
                    isDefault: true,
                    ...LocalCriticService.availability()
                },
                {
                    id: 'cloud',
                    label: 'Cloud (Gemini)',
                    blurb: 'Stronger model, whole-chapter context. Sends your text to Google.',
                    isDefault: false,
                    ...GeminiCriticService.availability()
                }
            ],
            lenses: listLenses(),
            defaultEngine: DEFAULT_ENGINE,
            defaultLens: DEFAULT_LENS
        };
    }

    /**
     * @param {string} text  The prose to analyse.
     * @param {object} opts  { engine, lens }
     * @returns {Promise<{ engine: string, lens: string, critique: string }>}
     */
    async analyze(text, opts = {}) {
        const engineId = this.resolve(opts.engine);
        const service = ENGINES[engineId];
        const lens = opts.lens || DEFAULT_LENS;

        console.log(`[CriticEngine] Running "${lens}" on the ${engineId} engine.`);
        const critique = await service.analyze(text, { lens });

        return { engine: engineId, lens, critique };
    }
}

module.exports = new CriticEngine();
