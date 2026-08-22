const fs = require('fs');
const PiperVoices = require('../services/narrator/PiperVoices');
const PiperService = require('../services/narrator/PiperService');
const ChapterAudioService = require('../services/narrator/ChapterAudioService');

const ExportService = require('../services/narrator/ExportService');
const GeminiVoice = require('../services/narrator/GeminiVoiceService');

/**
 * NarratorController
 *
 * Voices, and chapters rendered to audio.
 *
 * TWO ENGINES, TWO PURPOSES. Piper is local, free and unlimited, and everything
 * above renders with it - that is what listening to a chapter you are still
 * rewriting needs. The export endpoints at the bottom use Gemini, which acts
 * the line instead of just reading it, and which is metered. Nothing is spent
 * on prose that is still moving.
 *
 * Rendering is the one long operation here. A chapter is many paragraphs and
 * even at several times realtime that is tens of seconds, so it reports over
 * Socket.io as it goes and the HTTP response only settles at the end. The
 * writer can leave the tab; nothing about the render lives in the browser.
 */

function fail(res, err, where, status = 400) {
    console.error(`[NarratorController] ${where}:`, err.message);
    res.status(status).json({ ok: false, message: err.message });
}

/* ---------- voices ---------- */

/**
 * Installed voices always answer, even with no network. Being unable to reach
 * Hugging Face must not stop a writer rendering with a voice they already
 * have, so the catalogue is reported as a separate, failable half.
 */
exports.getVoices = async (req, res) => {
    try {
        const installed = await PiperVoices.installed();

        let catalogue = [];
        let catalogueError = null;
        try {
            catalogue = await PiperVoices.catalogue();
        } catch (err) {
            catalogueError = err.message;
        }

        res.json({
            ok: true,
            installed,
            voices: catalogue.map(v => ({ ...v, installed: installed.includes(v.id) })),
            catalogueError
        });
    } catch (err) {
        fail(res, err, 'getVoices', 500);
    }
};

/**
 * Downloads a voice. 20-120MB, so progress goes over the socket rather than
 * leaving the writer looking at a button that does nothing for a minute.
 */
exports.installVoice = async (req, res) => {
    const { id } = req.body || {};
    const io = req.app.locals.io;

    try {
        const result = await PiperVoices.install(id, (percent) => {
            io?.emit('narrator:voice-progress', { id, percent });
        });
        io?.emit('narrator:voice-installed', { id });
        res.json({ ok: true, ...result });
    } catch (err) {
        io?.emit('narrator:voice-failed', { id, message: err.message });
        fail(res, err, 'installVoice');
    }
};

exports.removeVoice = async (req, res) => {
    try {
        await PiperService.unload(req.params.id);
        res.json({ ok: true, ...(await PiperVoices.remove(req.params.id)) });
    } catch (err) {
        fail(res, err, 'removeVoice');
    }
};

/**
 * The speakers a voice carries. One entry for an ordinary voice; 109 for
 * VCTK, 904 for LibriTTS - all in the one file, reachable only by id.
 */
exports.getSpeakers = async (req, res) => {
    try {
        res.json({ ok: true, speakers: await PiperVoices.speakers(req.params.id) });
    } catch (err) {
        fail(res, err, 'getSpeakers');
    }
};

/** What the voice will actually say. For tuning a pronunciation by eye. */
exports.getPhonemes = async (req, res) => {
    const { voice, text } = req.query;
    try {
        res.json({ ok: true, phonemes: await PiperService.phonemesFor(voice, text || '') });
    } catch (err) {
        fail(res, err, 'getPhonemes');
    }
};

/**
 * Speaks a few words immediately, without caching them.
 *
 * This is the pronunciation Test button and nothing else, which is why it is
 * capped hard: it is for auditioning one respelling by ear, and anything
 * chapter-sized belongs in a render where the result is kept.
 */
const SAY_LIMIT = 200;

exports.say = async (req, res) => {
    const { voice, text, lengthScale, speaker, story } = req.query;
    const words = String(text || '').trim();

    if (!words) return fail(res, new Error('Nothing to say.'), 'say');
    if (words.length > SAY_LIMIT) {
        return fail(res, new Error(`That is too long to audition. Render the chapter instead.`), 'say');
    }

    try {
        // The pace matters here: this is also how the reading-speed control is
        // auditioned, and a sample at the wrong speed would be worse than none.
        // Auditioning a voice or a pace is only useful against the prose as
        // it will really be spoken, so the story's respellings are applied.
        let words2 = words;
        if (story) {
            try {
                const { applyLexicon } = require('../services/narrator/TextPlan');
                const DictionaryService = require('../services/proofing/DictionaryService');
                words2 = applyLexicon(words, await DictionaryService.lexicon(story));
            } catch { /* an audition without the lexicon still beats none */ }
        }

        const scale = Number(lengthScale);
        const audio = await PiperService.speak(voice, words2, {
            lengthScale: Number.isFinite(scale) && scale >= 0.5 && scale <= 3 ? scale : undefined,
            speaker: Number(speaker) || 0
        });
        const wav = ChapterAudioService.wav(audio.audio, audio.sampleRate);
        res.writeHead(200, {
            'Content-Type': 'audio/wav',
            'Content-Length': wav.length,
            'Cache-Control': 'no-store'
        });
        res.end(wav);
    } catch (err) {
        fail(res, err, 'say');
    }
};

/* ---------- chapter audio ---------- */

/**
 * What a render would do, before doing it: how many paragraphs, how many are
 * already on disk, and therefore how much work is actually left. The UI shows
 * this so "Render" is never a blind commitment.
 */
exports.getPlan = async (req, res) => {
    const { story, chapter, voice, lengthScale, speaker } = req.query;
    try {
        const plan = await ChapterAudioService.plan(story, chapter, voice, Number(lengthScale) || 1, Number(speaker) || 0);
        res.json({
            ok: true,
            total: plan.total,
            cached: plan.cached,
            pending: plan.total - plan.cached,
            words: plan.words
        });
    } catch (err) {
        fail(res, err, 'getPlan');
    }
};

exports.render = async (req, res) => {
    const { story, chapter, voice, lengthScale, force, speaker } = req.body || {};
    const io = req.app.locals.io;

    try {
        const manifest = await ChapterAudioService.render(story, chapter, voice, {
            lengthScale: Number(lengthScale) || 1,
            speaker: Number(speaker) || 0,
            force: force === true,
            onProgress: (progress) => {
                io?.emit('narrator:render-progress', { story, chapter, ...progress });
            }
        });

        io?.emit('narrator:render-done', { story, chapter, seconds: manifest.seconds });
        res.json({ ok: true, manifest });
    } catch (err) {
        io?.emit('narrator:render-failed', { story, chapter, message: err.message });
        fail(res, err, 'render');
    }
};

/** null manifest means "never rendered", which is not an error. */
exports.getManifest = async (req, res) => {
    const { story, chapter } = req.query;
    try {
        res.json({ ok: true, manifest: await ChapterAudioService.manifest(story, chapter) });
    } catch (err) {
        fail(res, err, 'getManifest');
    }
};

/**
 * Streams one rendered paragraph.
 *
 * Range requests are honoured because <audio> asks for them, and a player that
 * cannot seek inside a segment cannot resume one either.
 */
exports.getSegment = async (req, res) => {
    const { story, chapter } = req.query;
    try {
        const file = await ChapterAudioService.segmentPath(story, chapter, req.params.file);
        const stat = await fs.promises.stat(file);
        const range = req.headers.range;

        if (!range) {
            res.writeHead(200, {
                'Content-Type': 'audio/wav',
                'Content-Length': stat.size,
                'Accept-Ranges': 'bytes',
                // Named after a hash of its own contents, so it can never go
                // stale: different audio is a different filename.
                'Cache-Control': 'private, max-age=31536000, immutable'
            });
            fs.createReadStream(file).pipe(res);
            return;
        }

        const [startRaw, endRaw] = range.replace(/bytes=/, '').split('-');
        const start = Number(startRaw) || 0;
        const end = endRaw ? Number(endRaw) : stat.size - 1;

        if (start >= stat.size || end >= stat.size || start > end) {
            res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
            return;
        }

        res.writeHead(206, {
            'Content-Type': 'audio/wav',
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1
        });
        fs.createReadStream(file, { start, end }).pipe(res);

    } catch (err) {
        if (err.code === 'ENOENT') {
            fail(res, new Error('That audio has not been rendered.'), 'getSegment', 404);
            return;
        }
        fail(res, err, 'getSegment');
    }
};

/* ---------- music bed ---------- */

const path = require('path');
const Storage = require('../services/StorageService');

/**
 * Tracks live in a `.music` folder beside the stories, not inside one.
 *
 * Hidden, so listStories never offers it as a story - both listStories and
 * listChapters skip dot-entries already. Shared across every book because a
 * writer's atmosphere tracks are theirs, not one manuscript's, and copying an
 * mp3 into each story folder would be silly.
 */
const MUSIC_DIR = '.music';
const PLAYABLE = /\.(mp3|ogg|m4a|wav|flac|opus)$/i;

async function musicDir() {
    return path.join(await Storage.requireStoryRoot(), MUSIC_DIR);
}

exports.getMusic = async (req, res) => {
    try {
        const dir = await musicDir();
        let names;
        try {
            names = await fs.promises.readdir(dir);
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
            // Not created yet is the normal case, and the folder is the whole
            // instruction: tell the writer where to put files.
            return res.json({ ok: true, tracks: [], folder: dir });
        }

        const tracks = names.filter(n => PLAYABLE.test(n) && !n.startsWith('.')).sort();
        res.json({ ok: true, tracks, folder: dir });
    } catch (err) {
        fail(res, err, 'getMusic', 500);
    }
};

/**
 * Streams one track. The name must be a plain filename from that folder and is
 * checked against the same guard story names use, so no request can walk out
 * of it.
 */
exports.playMusic = async (req, res) => {
    const name = req.params.file;

    try {
        if (!Storage.isSafeSegment(name) || !PLAYABLE.test(name)) {
            return fail(res, new Error('That is not a music file.'), 'playMusic');
        }

        const dir = await musicDir();
        const file = path.join(dir, name);
        if (path.dirname(file) !== dir) {
            return fail(res, new Error('That is not a music file.'), 'playMusic');
        }

        const stat = await fs.promises.stat(file);
        const range = req.headers.range;
        const type = name.toLowerCase().endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';

        if (!range) {
            res.writeHead(200, {
                'Content-Type': type,
                'Content-Length': stat.size,
                'Accept-Ranges': 'bytes'
            });
            fs.createReadStream(file).pipe(res);
            return;
        }

        const [startRaw, endRaw] = range.replace(/bytes=/, '').split('-');
        const start = Number(startRaw) || 0;
        const end = endRaw ? Number(endRaw) : stat.size - 1;

        if (start >= stat.size || end >= stat.size || start > end) {
            return res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
        }

        res.writeHead(206, {
            'Content-Type': type,
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1
        });
        fs.createReadStream(file, { start, end }).pipe(res);

    } catch (err) {
        if (err.code === 'ENOENT') return fail(res, new Error('No such track.'), 'playMusic', 404);
        fail(res, err, 'playMusic');
    }
};

exports.clear = async (req, res) => {
    const { story, chapter } = req.body || {};
    try {
        res.json({ ok: true, ...(await ChapterAudioService.clear(story, chapter)) });
    } catch (err) {
        fail(res, err, 'clear');
    }
};

/* ---------- export: the performed take ---------- */

/**
 * What an export would cost, without spending anything.
 *
 * Answered from the chapter already on disk, so the paragraph and character
 * counts are free. Cached paragraphs are already paid for and are reported
 * separately - re-exporting after fixing a typo costs one paragraph, and the
 * writer should be able to see that before pressing anything.
 */
exports.getExportPlan = async (req, res) => {
    const { story, chapter, style, voice, model } = req.query;
    try {
        const [plan, available] = await Promise.all([
            ExportService.plan(story, chapter, { style, voice, model }),
            GeminiVoice.availability()
        ]);
        res.json({
            ok: true,
            available: available.ok,
            reason: available.reason,
            folder: plan.folder,
            total: plan.total,
            cached: plan.cached,
            pending: plan.pending,
            characters: plan.characters,
            pendingCharacters: plan.pendingCharacters
        });
    } catch (err) {
        fail(res, err, 'getExportPlan');
    }
};

/**
 * Render the chapter to <story>/export/chapter_NN/.
 *
 * Running out of the daily allowance is NOT an error and must not be reported
 * as one: every paragraph already rendered is on disk and hashed, so the next
 * run resumes rather than repeats. The response says how many are left and
 * carries the reset message, and the socket says the same - a writer who left
 * the tab open should not have to guess whether it failed or finished.
 */
exports.renderExport = async (req, res) => {
    const { story, chapter, style, voice, model, limit } = req.body || {};
    const io = req.app.locals.io;

    try {
        const result = await ExportService.render(story, chapter, {
            style, voice, model,
            limit: Number(limit) > 0 ? Number(limit) : undefined,
            onProgress: (progress) => {
                io?.emit('export:progress', { story, chapter, ...progress });
            }
        });

        io?.emit('export:done', {
            story, chapter,
            complete: result.complete,
            stopped: result.stopped,
            remaining: result.remaining,
            message: result.stoppedMessage || null
        });
        res.json({ ok: true, ...result });
    } catch (err) {
        io?.emit('export:failed', { story, chapter, message: err.message });
        fail(res, err, 'renderExport');
    }
};

/**
 * Listen to what has been exported so far.
 *
 * Stitched in memory rather than served off disk, because chapter.wav only
 * exists once the chapter is COMPLETE - and the whole point of this is to hear
 * the take while it is still three days from finished.
 *
 * CACHED, because a browser does not fetch audio once. It asks for a byte
 * range, then another, then seeks and asks again; regenerating a 30MB stitch
 * per request would make scrubbing unusable. The key includes how many
 * paragraphs are rendered, so the cache invalidates itself the moment another
 * one lands rather than serving yesterday's preview for ever.
 */
const previews = new Map();
const PREVIEW_LIMIT = 3;

exports.getExportPreview = async (req, res) => {
    const { story, chapter, style, voice, model } = req.query;

    try {
        const plan = await ExportService.plan(story, chapter, { style, voice, model });
        const key = `${story}/${chapter}/${plan.cached}/${style || ''}`;

        let preview = previews.get(key);
        if (!preview) {
            preview = await ExportService.preview(story, chapter, { style, voice, model });
            if (!preview.buffer) {
                return fail(res, new Error('Nothing has been exported for this chapter yet.'),
                    'getExportPreview', 404);
            }
            // A handful of chapters is plenty; these are tens of megabytes each.
            if (previews.size >= PREVIEW_LIMIT) previews.delete(previews.keys().next().value);
            previews.set(key, preview);
        }

        const wav = preview.buffer;
        const range = req.headers.range;

        // How much of the chapter this actually is, so the UI can say so
        // without a second request.
        const headers = {
            'Content-Type': 'audio/wav',
            'Accept-Ranges': 'bytes',
            'X-Export-Paragraphs': String(preview.paragraphs),
            'X-Export-Total': String(preview.total),
            // Never cached by the browser: it changes as rendering continues.
            'Cache-Control': 'no-store'
        };

        if (!range) {
            res.writeHead(200, { ...headers, 'Content-Length': wav.length });
            return res.end(wav);
        }

        const [startRaw, endRaw] = range.replace(/bytes=/, '').split('-');
        const start = Number(startRaw) || 0;
        const end = endRaw ? Number(endRaw) : wav.length - 1;

        if (start >= wav.length || end >= wav.length || start > end) {
            return res.writeHead(416, { 'Content-Range': `bytes */${wav.length}` }).end();
        }

        res.writeHead(206, {
            ...headers,
            'Content-Range': `bytes ${start}-${end}/${wav.length}`,
            'Content-Length': end - start + 1
        });
        res.end(wav.subarray(start, end + 1));
    } catch (err) {
        fail(res, err, 'getExportPreview');
    }
};

/**
 * Audition one paragraph with a direction, without committing the chapter.
 *
 * WHY THIS EXISTS. The style prompt is part of every segment hash, so changing
 * one word makes a whole chapter stale - 70 paragraphs against a 31-a-day
 * allowance, two days of quota per attempt at the wording. Tuning the
 * direction at chapter scale is therefore impossible in practice. One
 * paragraph is one request, so six attempts cost six.
 *
 * Nothing is cached and nothing is written to disk: an audition is a question,
 * not a product. The same reasoning as `say` above, for the same reason.
 *
 * Defaults to a paragraph WITH DIALOGUE IN IT, because that is the hard case.
 * Drama applied to narration reads as intensity; the same drama applied to a
 * character's line reads as whining, and a direction tuned on description
 * alone will not reveal that.
 */
exports.auditionExport = async (req, res) => {
    const { story, chapter, style, voice, model, index } = req.query;

    try {
        const paragraphs = await ExportService.paragraphs(story, chapter);
        if (!paragraphs.length) {
            return fail(res, new Error('That chapter has nothing to narrate.'), 'auditionExport', 404);
        }

        const wanted = Number(index);
        const pick = Number.isInteger(wanted) && paragraphs[wanted]
            ? paragraphs[wanted]
            : (paragraphs.find(p => p.hasDialogue) || paragraphs[0]);

        const audio = await GeminiVoice.speak(voice || GeminiVoice.defaultVoice, pick.text, { style, model });
        const wav = ChapterAudioService.wav(audio.audio, audio.sampleRate);

        res.writeHead(200, {
            'Content-Type': 'audio/wav',
            'Content-Length': wav.length,
            'Cache-Control': 'no-store',
            // So the UI can say WHICH paragraph it just played, and whether it
            // was one with dialogue in it.
            'X-Audition-Index': String(pick.index),
            'X-Audition-Dialogue': pick.hasDialogue ? '1' : '0',
            'X-Audition-Total': String(paragraphs.length)
        });
        res.end(wav);
    } catch (err) {
        // A quota stop here is worth its own words: it is one request, so
        // hitting it means the allowance is genuinely gone for the day.
        fail(res, err, 'auditionExport');
    }
};
