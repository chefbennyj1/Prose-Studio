const SpellService = require('../services/proofing/SpellService');
const SuggestionService = require('../services/proofing/SuggestionService');

/**
 * ProofingController
 *
 * Two speeds, deliberately separated:
 *
 *   Spelling is exact and takes single-digit milliseconds for a chapter, so it
 *   returns inline. Gemma's edit suggestions take minutes — a cold model load
 *   plus a pass per chunk — so the completion scan acknowledges immediately and
 *   pushes results over Socket.io when they land.
 *
 * That second pattern is lifted from the Proof-Reader plugin, which learned it
 * the hard way: holding a request open for the length of an LLM run consumes a
 * browser connection per save, and a few of those exhaust the pool and stall
 * the editor.
 */

exports.getStatus = (req, res) => {
    res.json({
        ok: true,
        spelling: { ok: true },
        suggestions: SuggestionService.availability()
    });
};

/**
 * Fast path: spelling only. Safe to call often.
 */
exports.checkSpelling = async (req, res) => {
    const { text, seriesFolder } = req.body || {};
    if (typeof text !== 'string') {
        return res.status(400).json({ ok: false, message: "Provide a 'text' string to check." });
    }

    try {
        const result = await SpellService.check(text, { seriesFolder });
        res.json({ ok: true, ...result });
    } catch (err) {
        console.error('[ProofingController] Spell check failed:', err.message);
        res.status(500).json({ ok: false, message: err.message });
    }
};

/**
 * Completion scan: run when the writer marks a page finished, not while typing.
 * Returns spelling straight away; suggestions arrive on the socket.
 */
exports.scanOnComplete = async (req, res) => {
    const { text, seriesFolder, socketId, target } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ ok: false, message: "Provide a 'text' string to scan." });
    }

    let spelling;
    try {
        spelling = await SpellService.check(text, { seriesFolder });
    } catch (err) {
        console.error('[ProofingController] Spell check failed:', err.message);
        return res.status(500).json({ ok: false, message: err.message });
    }

    const engine = SuggestionService.availability();

    // Answer now. The editor never waits on the model.
    res.json({
        ok: true,
        spelling,
        suggestionsPending: engine.ok,
        suggestionsUnavailable: engine.ok ? null : engine.reason
    });

    if (!engine.ok) {
        console.log(`[ProofingController] Skipping suggestions: ${engine.reason}`);
        return;
    }

    const io = req.app.locals.io;
    const deliver = (payload) => {
        if (!io) return;
        const channel = socketId ? io.to(socketId) : io; // scope to the requester
        channel.emit('proofing_suggestions', { target: target || null, ...payload });
    };

    try {
        const result = await SuggestionService.suggest(text);
        deliver({ ok: true, ...result });
    } catch (err) {
        console.error('[ProofingController] Suggestion scan failed:', err.message);
        deliver({ ok: false, suggestions: [], message: err.message });
    }
};

exports.getDictionary = (req, res) => {
    const { seriesFolder } = req.params;
    try {
        res.json({ ok: true, words: SpellService.readCustomWords(seriesFolder) });
    } catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
};

/**
 * "Add to dictionary" for a word the writer has decided is correct. Unlike the
 * browser's version, this is per-series, on disk, and travels with the repo.
 */
exports.addDictionaryWord = (req, res) => {
    const { seriesFolder, word } = req.body || {};
    try {
        const words = SpellService.addCustomWord(seriesFolder, word);
        res.json({ ok: true, words });
    } catch (err) {
        res.status(400).json({ ok: false, message: err.message });
    }
};
