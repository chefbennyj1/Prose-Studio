const CriticEngine = require("../services/critic/CriticEngine");

/**
 * CriticController
 *
 * Passage in, Markdown out. The old volume-wide entry point fed the critic a
 * comic screenplay assembled by ScriptService from panel dialogue; both went
 * with the comic stack. What remains is the shape the prose editor actually
 * wants — critique a selection, save nothing.
 */

// Async now: describing the critic includes asking whether the AI is switched
// on, which is a question about saved settings.
exports.getOptions = async (req, res) => {
    try {
        res.json({ ok: true, ...(await CriticEngine.describe()) });
    } catch (err) {
        console.error("[CriticController] Could not describe the critic:", err.message);
        res.status(500).json({ ok: false, message: err.message });
    }
};

exports.analyzeText = async (req, res) => {
    // `engine` is gone from the body: there is one engine now. See CriticEngine.
    const { text, lens } = req.body || {};

    if (typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ ok: false, message: "Provide a 'text' string to critique." });
    }

    try {
        const result = await CriticEngine.analyze(text, { lens });
        res.json({ ok: true, ...result });
    } catch (err) {
        console.error("[CriticController] Passage analysis error:", err.message);
        res.status(500).json({ ok: false, message: err.message });
    }
};
