const fs = require('fs');
const PiperVoices = require('../services/narrator/PiperVoices');
const PiperService = require('../services/narrator/PiperService');
const ChapterAudioService = require('../services/narrator/ChapterAudioService');

/**
 * NarratorController
 *
 * Voices, and chapters rendered to audio. All of it local - there is no cloud
 * TTS in the Prose Engine and no API key to configure.
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
