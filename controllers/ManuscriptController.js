const ManuscriptService = require('../services/manuscript/ManuscriptService');

/**
 * A missing story root is a configuration gap, not a bad request: answer 409
 * with a code the editor can recognise, so it can point the writer at Settings
 * rather than showing a filesystem error they cannot act on.
 */
function fail(res, err, context) {
    if (err.code === 'NO_STORY_ROOT') {
        return res.status(409).json({ ok: false, code: 'NO_STORY_ROOT', message: err.message });
    }
    if (err.code === 'STALE_WRITE') {
        return res.status(409).json({ ok: false, stale: true, message: err.message, currentModified: err.currentModified });
    }
    console.error(`[Manuscript] ${context} failed:`, err.message);
    res.status(400).json({ ok: false, message: err.message });
}

/* ---------- stories ---------- */

exports.listStories = async (req, res) => {
    try {
        res.json({ ok: true, stories: await ManuscriptService.listStories() });
    } catch (err) {
        fail(res, err, 'listStories');
    }
};

exports.createStory = async (req, res) => {
    try {
        res.json({ ok: true, story: await ManuscriptService.createStory(req.body?.name) });
    } catch (err) {
        fail(res, err, 'createStory');
    }
};

/* ---------- chapters ---------- */

exports.listChapters = async (req, res) => {
    try {
        res.json({ ok: true, chapters: await ManuscriptService.listChapters(req.query.story) });
    } catch (err) {
        fail(res, err, 'listChapters');
    }
};

exports.createChapter = async (req, res) => {
    const { story, name } = req.body || {};
    try {
        res.json({ ok: true, chapter: await ManuscriptService.createChapter(story, name) });
    } catch (err) {
        fail(res, err, 'createChapter');
    }
};

/* ---------- chapter text ---------- */
// Pages are computed from word count, not stored — there is nothing to create.

exports.readChapter = async (req, res) => {
    const { story, chapter } = req.query;
    try {
        res.json({ ok: true, pageWords: ManuscriptService.PAGE_WORDS, ...(await ManuscriptService.read(story, chapter)) });
    } catch (err) {
        fail(res, err, 'readChapter');
    }
};

exports.saveChapter = async (req, res) => {
    const { story, chapter, text, baseModified } = req.body || {};
    try {
        const result = await ManuscriptService.write(story, chapter, text, baseModified || null);
        res.json({ ok: true, ...result });
    } catch (err) {
        // A stale write is the writer's problem to resolve, not a server fault:
        // 409 so the editor can offer a reload instead of showing a red error.
        fail(res, err, 'saveChapter');
    }
};
