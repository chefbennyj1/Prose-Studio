const SpellService = require('../services/proofing/SpellService');
const SuggestionService = require('../services/proofing/SuggestionService');
const MechanicsService = require('../services/proofing/MechanicsService');

/**
 * ProofingController
 *
 * Two speeds, deliberately separated:
 *
 *   Spelling and mechanics are exact, local, and take single-digit milliseconds
 *   for a chapter, so they return inline. Edit suggestions go to Gemini, which
 *   is fast but not instant on a full chapter, so the scan acknowledges
 *   immediately and pushes results over Socket.io when they land.
 *
 * That second pattern is kept even though the model is much quicker than the
 * local one it replaced: holding a request open for the length of an LLM run
 * consumes a browser connection per save, and a few of those exhaust the pool
 * and stall the editor.
 *
 * Only the suggestions half needs the AI. Spelling and mechanics run whether or
 * not the writer has switched it on, which is what makes the AI genuinely
 * optional rather than nominally so.
 */

exports.getStatus = async (req, res) => {
    res.json({
        ok: true,
        spelling: { ok: true },
        mechanics: { ok: true },
        // Async now: whether this can run is a question about saved settings
        // and an API key, not about a plugin being loaded in this process.
        suggestions: await SuggestionService.availability()
    });
};

/** The rule and group list, so the rail can build its toggles. */
exports.getMechanicsRules = (req, res) => {
    res.json({ ok: true, ...MechanicsService.describe() });
};

/**
 * Mechanics: punctuation, dialogue, grammar and layout.
 *
 * Pure regex over the text — no model, no plugin, no network — so unlike the
 * suggestion scan there is nothing to wait on and nothing to push over a
 * socket. It answers in the response, every time.
 */
exports.checkMechanics = (req, res) => {
    const { text, options } = req.body || {};
    if (typeof text !== 'string') {
        return res.status(400).json({ ok: false, message: "Provide a 'text' string to scan." });
    }

    try {
        const result = MechanicsService.scan(text, options || {});
        console.log(`[ProofingController] Mechanics: ${result.counts.total} finding(s) in ${result.stats.words} words.`);
        res.json({ ok: true, ...result });
    } catch (err) {
        console.error('[ProofingController] Mechanics scan failed:', err.message);
        res.status(500).json({ ok: false, message: err.message });
    }
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

    // What the caller actually asked for. Defaults to everything, which is what
    // this endpoint has always done and what a completion scan wants.
    //
    // The caller has to be able to narrow it, because the rail offers spelling
    // and mechanics as their own rows: running all three behind a button
    // labelled "Line edits" gave the writer two lists they did not ask for and
    // buried the one they did at the bottom.
    const requested = Array.isArray(req.body?.parts) ? req.body.parts : null;
    const wants = (part) => !requested || requested.includes(part);

    let spelling = null;
    if (wants('spelling')) {
        try {
            spelling = await SpellService.check(text, { seriesFolder });
        } catch (err) {
            console.error('[ProofingController] Spell check failed:', err.message);
            return res.status(500).json({ ok: false, message: err.message });
        }
    }

    // Mechanics rides along free when it is wanted: regex over text the request
    // already holds, so a full scan has no reason to make the writer ask twice.
    let mechanics = null;
    if (wants('mechanics')) {
        try {
            mechanics = MechanicsService.scan(text, req.body?.mechanics || {});
        } catch (err) {
            console.error('[ProofingController] Mechanics scan failed:', err.message);
        }
    }

    const engine = wants('suggestions')
        ? await SuggestionService.availability()
        : { ok: false, reason: null };

    // Answer now. The editor never waits on the model.
    res.json({
        ok: true,
        spelling,
        mechanics,
        suggestionsPending: engine.ok,
        suggestionsUnavailable: engine.ok ? null : engine.reason
    });

    if (!engine.ok) {
        if (engine.reason) console.log(`[ProofingController] Skipping suggestions: ${engine.reason}`);
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
