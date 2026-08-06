const DictionaryService = require('../services/proofing/DictionaryService');
const SpellService = require('../services/proofing/SpellService');
const PiperService = require('../services/narrator/PiperService');

/**
 * DictionaryController
 *
 * The writer's words: which ones are real, and how they are said.
 *
 * Every write invalidates the spell checker for that story. The checker holds
 * a prepared nspell instance with the custom words already added, so a word
 * saved here is invisible to it until that is thrown away - which is exactly
 * the bug this merge exists to kill, in a different disguise.
 */

function fail(res, err, where, status = 400) {
    console.error(`[DictionaryController] ${where}:`, err.message);
    res.status(status).json({ ok: false, message: err.message });
}

/**
 * Both layers, kept apart rather than merged, because the page has to show
 * which list a word is in before it can offer to move it.
 */
exports.get = async (req, res) => {
    try {
        const layers = await DictionaryService.layers(req.query.story);
        res.json({ ok: true, ...layers });
    } catch (err) {
        fail(res, err, 'get');
    }
};

exports.set = async (req, res) => {
    const { scope, story, word, spoken } = req.body || {};
    try {
        const layers = await DictionaryService.set(scope || 'story', story, word, spoken);
        SpellService.invalidate(story);
        res.json({ ok: true, ...layers });
    } catch (err) {
        fail(res, err, 'set');
    }
};

exports.remove = async (req, res) => {
    const { scope, story, word } = req.body || {};
    try {
        const layers = await DictionaryService.remove(scope || 'story', story, word);
        SpellService.invalidate(story);
        res.json({ ok: true, ...layers });
    } catch (err) {
        fail(res, err, 'remove');
    }
};

/** Between the global list and this story's, keeping the pronunciation. */
exports.move = async (req, res) => {
    const { scope, story, word } = req.body || {};
    try {
        const layers = await DictionaryService.move(scope || 'story', story, word);
        SpellService.invalidate(story);
        res.json({ ok: true, ...layers });
    } catch (err) {
        fail(res, err, 'move');
    }
};

/**
 * What the narrator will actually say for a word.
 *
 * Cheap - it reads the voice's config and runs espeak, and never loads the
 * model - so the dictionary page can call it as the writer types and show a
 * respelling failing before it is ever saved.
 */
exports.phonemes = async (req, res) => {
    const { voice, text } = req.query;
    try {
        res.json({ ok: true, phonemes: await PiperService.phonemesFor(voice, text || '') });
    } catch (err) {
        fail(res, err, 'phonemes');
    }
};
