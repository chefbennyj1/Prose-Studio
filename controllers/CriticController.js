const CriticEngine = require("../services/critic/CriticEngine");

/**
 * CriticController
 *
 * Passage in, Markdown out. The old volume-wide entry point fed the critic a
 * comic screenplay assembled by ScriptService from panel dialogue; both went
 * with the comic stack. What remains is the shape the prose editor actually
 * wants — critique a selection, save nothing.
 */

exports.getOptions = (req, res) => {
    res.json({ ok: true, ...CriticEngine.describe() });
};
exports.analyzeText = async (req, res) => {
    const { text, engine, lens } = req.body || {};

    if (typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ ok: false, message: "Provide a 'text' string to critique." });
    }

    try {
        const result = await CriticEngine.analyze(text, { engine, lens });
        res.json({ ok: true, ...result });
    } catch (err) {
        console.error("[CriticController] Passage analysis error:", err.message);
        res.status(500).json({ ok: false, message: err.message });
    }
};
