const SpellService = require('../services/proofing/SpellService');
const SuggestionService = require('../services/proofing/SuggestionService');
const MechanicsService = require('../services/proofing/MechanicsService');
const OveruseService = require('../services/proofing/OveruseService');
const ThesaurusService = require('../services/proofing/ThesaurusService');
const WordCloudService = require('../services/proofing/WordCloudService');
const DictionaryService = require('../services/proofing/DictionaryService');
const GeminiOveruseService = require('../services/gemini/GeminiOveruseService');
const ManuscriptService = require('../services/manuscript/ManuscriptService');

/**
 * One way to report a failure, matching NarratorController's.
 *
 * These three lines were written out six times in this file, which is how a
 * handler copied from the other controller arrived calling a fail() that did
 * not exist here - a ReferenceError that reached the browser as an HTML error
 * page and read as a routing problem.
 *
 * NOT applied to three catch blocks that look like these and are not:
 *   - the overuse judgement, which returns ok:true with the counts intact,
 *     because the numbers survive an opinion that did not arrive
 *   - the mechanics pass inside spell, which logs and carries on
 *   - the suggestion scan, which answers over `deliver` rather than `res`
 */
function fail(res, err, where, status = 500) {
    console.error(`[ProofingController] ${where}:`, err.message);
    res.status(status).json({ ok: false, message: err.message });
}

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
        fail(res, err, 'Mechanics scan failed');
    }
};

/** The word and group list, so the rail can build its toggles. */
exports.getOveruseWords = (req, res) => {
    res.json({ ok: true, ...OveruseService.describe() });
};

/**
 * Overused words across a WHOLE story, not a chapter.
 *
 * The scope is the point. A writer cannot see their own tics chapter by
 * chapter, because they never read the book the way a reader does - three
 * "absolutely"s in a chapter is nothing and sixty across a novel is a habit.
 *
 * Two halves, and they fail independently. The count is local, exact and
 * always runs; the verdicts need the AI and are asked for only when the writer
 * ticked the box. A failure in the second half must not cost the writer the
 * first - the numbers are the part they can act on, so a dead API key returns
 * the tally with a note attached rather than an error page.
 *
 * Reading a whole manuscript is disk work, not model work, so unlike
 * scanOnComplete this answers in the response. A long novel is a few hundred
 * milliseconds of file reads; there is nothing here worth a socket.
 */
exports.checkOveruse = async (req, res) => {
    const { story, options, judge } = req.body || {};
    if (typeof story !== 'string' || !story.trim()) {
        return res.status(400).json({ ok: false, message: "Provide a 'story' to scan." });
    }

    try {
        const list = await ManuscriptService.listChapters(story);
        if (!list.length) {
            /*
             * "No chapters" and "no such story" are different answers and only
             * one of them is good news.
             *
             * resolveStory builds a path without checking that anything is
             * there, and a missing folder lists as zero files - so a renamed or
             * deleted story would report "nothing counted", which a writer
             * reads as "my prose is clean". Worth one extra directory read on
             * the empty path to tell them the truth instead.
             */
            const stories = await ManuscriptService.listStories();
            const known = stories.some(entry => (entry.name || entry) === story);
            if (!known) {
                return res.status(404).json({ ok: false, message: `There is no story called "${story}".` });
            }

            return res.json({
                ok: true,
                words: [], chapters: [],
                stats: { words: 0, chapters: 0, distinct: 0 },
                counts: { total: 0, narration: 0, dialogue: 0, per10k: 0 }
            });
        }

        const chapters = [];
        for (const entry of list) {
            const { text } = await ManuscriptService.read(story, entry.name);
            chapters.push({ chapter: entry.name, text });
        }

        const report = OveruseService.scan(chapters, options || {});
        console.log(`[ProofingController] Overuse: ${report.counts.total} use(s) of ${report.stats.distinct} word(s) across ${report.stats.chapters} chapter(s), ${report.stats.words} words.`);

        if (!judge) return res.json({ ok: true, ...report });

        try {
            const verdict = await GeminiOveruseService.judge(report);
            return res.json({ ok: true, ...report, judgement: verdict });
        } catch (err) {
            // The counts survive. Say why the opinion did not.
            console.error('[ProofingController] Overuse judgement failed:', err.message);
            return res.json({ ok: true, ...report, judgement: { error: err.message } });
        }
    } catch (err) {
        fail(res, err, 'Overuse scan failed');
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
        fail(res, err, 'Spell check failed');
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
            return fail(res, err, 'Spell check failed');
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

/**
 * Synonyms for one highlighted word.
 *
 * Local in every sense that matters to a writer: no key, no account, no model,
 * and it works with the AI switched off. See ThesaurusService for why the list
 * is short and ordered the way it is.
 */
exports.getThesaurus = async (req, res) => {
    const { word, pos } = req.query;
    try {
        res.json({ ok: true, ...await ThesaurusService.lookup(word, { pos }) });
    } catch (err) {
        /*
         * Offline, or a phrase rather than a word. Both are the writer's to
         * act on, so the message goes through unchanged.
         *
         * Written out rather than routed through a fail() helper: this file
         * does not have one. NarratorController does, and copying its shape
         * across put a call to a function that does not exist in here - which
         * only surfaced when the endpoint was first hit, as a ReferenceError
         * that reached the browser as an HTML error page.
         */
        // 400 rather than 500: "look up a single word" and "could not reach
        // the thesaurus" are both about the request, not a fault in here.
        fail(res, err, 'Thesaurus lookup failed', 400);
    }
};

/**
 * What the story is made of, by weight.
 *
 * Whole-novel by default: every chapter, function words removed, ranked by how
 * often the writer actually reaches for a word. `chapter` switches to the
 * TF-IDF view - what makes ONE chapter different from the rest.
 *
 * Character names come from the story's pronunciation lexicon. It is not a
 * complete cast list, but it is free and it is real: those are the words the
 * writer has already had to teach the narrator to say, which in practice is
 * mostly names. They are exempt from the length and frequency floors, so a
 * three-letter protagonist is not quietly dropped.
 */
exports.getWordCloud = async (req, res) => {
    const { story, chapter } = req.query;
    if (typeof story !== 'string' || !story.trim()) {
        return fail(res, new Error("Provide a 'story' to read."), 'getWordCloud', 400);
    }

    try {
        const list = await ManuscriptService.listChapters(story);
        if (!list.length) {
            return fail(res, new Error(`There is nothing written in "${story}" yet.`), 'getWordCloud', 404);
        }

        const [chapters, lexicon] = await Promise.all([
            Promise.all(list.map(async ({ name }) => ({
                chapter: name,
                text: (await ManuscriptService.read(story, name)).text
            }))),
            DictionaryService.lexicon(story).catch(() => ({}))
        ]);

        const cloud = WordCloudService.build(chapters, {
            chapter: chapter || undefined,
            names: Object.keys(lexicon || {})
        });

        res.json({ ok: true, story, chapters: list.map(c => c.name), ...cloud });
    } catch (err) {
        fail(res, err, 'getWordCloud');
    }
};
