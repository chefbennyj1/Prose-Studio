const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const Storage = require('../StorageService');
const ManuscriptService = require('../manuscript/ManuscriptService');
const DictionaryService = require('../proofing/DictionaryService');
const PiperService = require('./PiperService');
const { planChapter } = require('./TextPlan');

/**
 * ChapterAudioService
 *
 * A chapter, rendered to a folder of paragraph-sized audio files that the
 * browser plays as a playlist.
 *
 * WHY FILES AND NOT STREAMING. Streaming means synthesising the same prose
 * again every time it is played. That was affordable when the engine ran in
 * the reader's own browser and unaffordable the moment a paid API was
 * considered, and it is still wasteful now that the engine is local: a chapter
 * is read back many times during revision and changes in one paragraph at a
 * time. Rendering to files turns that into work done once.
 *
 * WHY PARAGRAPHS. A paragraph is the largest unit that is still a natural
 * seam. Synthesised in one pass the voice holds its prosody across the
 * sentences inside it, instead of resetting at every full stop the way the
 * live narrator has to. It is also the unit a writer edits, which is what
 * makes the caching below worth having.
 *
 *
 * STALENESS is by content hash, not timestamp. Each segment is named after a
 * hash of the voice and the exact text it speaks, so:
 *   - editing one paragraph re-renders that paragraph and nothing else
 *   - reordering paragraphs renders nothing at all, it just reorders the list
 *   - a stray whitespace change that does not alter the words is still a
 *     change, which is the honest answer, but it costs one paragraph
 * An mtime on the chapter file could only ever say "something changed", which
 * would mean re-rendering the whole chapter for a fixed typo.
 */

// Hidden, and inside the story it belongs to, so moving or deleting a story
// takes its audio with it. Hidden also keeps it out of listStories/listChapters,
// both of which skip dot-entries already.
const AUDIO_DIR = '.audio';

const MANIFEST = 'manifest.json';
const MANIFEST_VERSION = 1;

/**
 * Silence between paragraphs and at a scene break, in seconds.
 *
 * These sit on top of PiperService's SENTENCE_GAP (0.35s), and the three have
 * to stay clearly separated or the structure stops being audible: a new
 * paragraph must sound longer than a new sentence, and a scene break longer
 * again. Ranked rather than tuned - a listener hears the ordering, not the
 * numbers.
 *
 * Stored in the manifest rather than baked into the audio, so changing them
 * costs a page reload and not a re-render.
 */
const PARAGRAPH_GAP = 0.75;
const SCENE_GAP = 1.6;

// One render per chapter at a time. Two overlapping renders would write the
// same manifest from two different states and sweep each other's files.
const inFlight = new Map();

function keyFor(story, chapter) {
    return `${story}/${chapter}`;
}

async function audioDir(story, chapter) {
    const root = await Storage.requireStoryRoot();
    if (!Storage.isSafeSegment(story)) throw new Error('Invalid story name.');
    if (!Storage.isSafeSegment(chapter)) throw new Error('Invalid chapter name.');

    const dir = path.join(root, story, AUDIO_DIR, chapter);
    const relative = path.relative(root, dir);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('That location is outside the story folder.');
    }
    return dir;
}

/**
 * Bump this whenever a change to the synthesis pipeline makes the SAME text
 * produce DIFFERENT audio. It is part of every segment hash, so raising it
 * invalidates every rendered file everywhere and the next render redoes them.
 *
 * Without it a fix is invisible: the cache is keyed on the words, the words
 * did not change, and every chapter goes on serving audio made by the old
 * code.
 *
 *   1  first release
 *   2  punctuation restored before phonemization. Until this, every comma
 *      and full stop was stripped and Piper read whole paragraphs as one
 *      run-on breath with no pauses in them.
 *   3  one sentence per pass, joined with a chosen silence, so every sentence
 *      is a complete utterance and its pitch lands at the full stop.
 *   4  pauses inside a sentence lengthened after synthesis, so a comma reads
 *      as a breath. Piper's own is short enough to sound like a stumble.
 */
const RENDER_VERSION = 4;

/** Voice, pipeline and text together: changing any must produce a new file. */
function hashFor(voice, lengthScale, text) {
    return crypto.createHash('sha1')
        .update(`v${RENDER_VERSION} ${voice} ${lengthScale} ${text}`)
        .digest('hex')
        .slice(0, 16);
}

/** 16-bit PCM WAV. No encoder dependency, and every browser plays it. */
function wavBuffer(samples, rate) {
    const pcm = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
        const c = Math.max(-1, Math.min(1, samples[i]));
        pcm.writeInt16LE(Math.round(c * 32767), i * 2);
    }

    const head = Buffer.alloc(44);
    head.write('RIFF', 0);
    head.writeUInt32LE(36 + pcm.length, 4);
    head.write('WAVE', 8);
    head.write('fmt ', 12);
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);
    head.writeUInt16LE(1, 22);
    head.writeUInt32LE(rate, 24);
    head.writeUInt32LE(rate * 2, 28);
    head.writeUInt16LE(2, 32);
    head.writeUInt16LE(16, 34);
    head.write('data', 36);
    head.writeUInt32LE(pcm.length, 40);

    return Buffer.concat([head, pcm]);
}

class ChapterAudioService {

    /** Exposed so the pronunciation audition can return a wav without a file. */
    wav(samples, rate) {
        return wavBuffer(samples, rate);
    }

    /**
     * The paragraphs and scene breaks a render would produce, without
     * rendering anything. Used to report what is already done and what a
     * render would cost before the writer commits to it.
     */
    async plan(story, chapter, voice, lengthScale = 1) {
        const [{ text }, lexicon] = await Promise.all([
            ManuscriptService.read(story, chapter),
            DictionaryService.lexicon(story)
        ]);

        const dir = await audioDir(story, chapter);

        const segments = [];
        for (const block of planChapter(text, lexicon)) {
            if (block.kind !== 'text') {
                segments.push({ kind: 'break', seconds: SCENE_GAP });
                continue;
            }
            const body = block.text.trim();
            if (!body) continue;

            const hash = hashFor(voice, lengthScale, body);
            segments.push({
                kind: 'text',
                hash,
                file: `${hash}.wav`,
                text: body,
                gap: PARAGRAPH_GAP,
                cached: await exists(path.join(dir, `${hash}.wav`))
            });
        }

        const speech = segments.filter(s => s.kind === 'text');
        return {
            dir,
            segments,
            total: speech.length,
            cached: speech.filter(s => s.cached).length,
            words: speech.reduce((n, s) => n + s.text.split(/\s+/).length, 0)
        };
    }

    /**
     * @param {object}   options
     * @param {boolean}  options.force       rebuild every paragraph, cached or not
     * @param {function} options.onProgress  ({done, total, cached, text}) per segment
     *
     * Only paragraphs whose hash has no file are synthesised; the rest are
     * already on disk from a previous render and are reported as cached.
     *
     * A render already running for this chapter is not started twice. But it
     * cannot simply be shared either: the running job planned itself against
     * the text as it was when it started, and the caller asking now may have
     * just saved a change it will never see. So the request is remembered and
     * one more pass runs when the current one finishes. That pass is nearly
     * free if nothing else changed, and it is what makes render-on-save safe
     * to fire while a render is already going.
     */
    async render(story, chapter, voice, options = {}) {
        const key = keyFor(story, chapter);

        const running = inFlight.get(key);
        if (running) {
            running.again = true;
            return running.job;
        }

        const entry = { again: false, job: null };
        entry.job = (async () => {
            let result = await this.#render(story, chapter, voice, options);
            while (entry.again) {
                entry.again = false;
                // The follow-up must not force: forcing was the first pass's
                // instruction, and repeating it would rebuild the lot again.
                result = await this.#render(story, chapter, voice, { ...options, force: false });
            }
            return result;
        })().finally(() => inFlight.delete(key));

        inFlight.set(key, entry);
        return entry.job;
    }

    async #render(story, chapter, voice, { lengthScale = 1, force = false, onProgress } = {}) {
        const started = Date.now();
        const { dir, segments, total } = await this.plan(story, chapter, voice, lengthScale);
        await fsp.mkdir(dir, { recursive: true });

        // Force means "distrust what is on disk" - the words and the voice are
        // unchanged, so the hashes are too, and nothing would be rebuilt
        // otherwise. This is the escape hatch for audio that is wrong for a
        // reason the hash cannot see.
        if (force) segments.forEach(s => { s.cached = false; });

        let done = 0;
        let rendered = 0;
        let sampleRate = 0;
        let seconds = 0;

        for (const segment of segments) {
            if (segment.kind !== 'text') continue;

            const target = path.join(dir, segment.file);

            if (segment.cached) {
                // Duration is needed for the manifest whether it was rendered
                // now or a week ago; a WAV header carries it.
                const known = await durationOf(target);
                if (known) {
                    segment.seconds = known.seconds;
                    sampleRate = sampleRate || known.rate;
                    seconds += known.seconds;
                    done += 1;
                    onProgress?.({ done, total, cached: true, text: segment.text });
                    continue;
                }
                // Unreadable: treat as missing and render it again.
                segment.cached = false;
            }

            const audio = await PiperService.speak(voice, segment.text, { lengthScale });
            sampleRate = audio.sampleRate;

            // Written to a temporary name first: a half-written wav that
            // carries the real hash would be treated as a valid cache hit for
            // ever after.
            const part = `${target}.part`;
            await fsp.writeFile(part, wavBuffer(audio.audio, audio.sampleRate));
            await fsp.rename(part, target);

            segment.seconds = audio.audio.length / audio.sampleRate;
            segment.chunks = audio.chunks;
            seconds += segment.seconds;
            rendered += 1;
            done += 1;
            onProgress?.({ done, total, cached: false, text: segment.text });
        }

        const manifest = {
            version: MANIFEST_VERSION,
            story,
            chapter,
            voice,
            lengthScale,
            sampleRate,
            seconds,
            renderedAt: Date.now(),
            segments: segments.map(s => s.kind === 'text'
                ? { kind: 'text', file: s.file, seconds: s.seconds, gap: s.gap, text: s.text.slice(0, 120) }
                : { kind: 'break', seconds: s.seconds })
        };

        await fsp.writeFile(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');
        const swept = await this.#sweep(dir, segments);

        console.log(`[ChapterAudioService] ${story}/${chapter}: ${rendered} rendered, ` +
            `${total - rendered} reused, ${swept} swept, ${seconds.toFixed(1)}s audio ` +
            `in ${((Date.now() - started) / 1000).toFixed(1)}s`);

        return { ...manifest, rendered, reused: total - rendered, swept };
    }

    /**
     * Deletes rendered files the current manifest no longer references -
     * paragraphs that were cut or rewritten, and everything belonging to a
     * previously used voice. Without this the folder only ever grows, and a
     * chapter revised twenty times would keep every version it ever had.
     */
    async #sweep(dir, segments) {
        const keep = new Set(segments.filter(s => s.kind === 'text').map(s => s.file));
        keep.add(MANIFEST);

        let names;
        try {
            names = await fsp.readdir(dir);
        } catch {
            return 0;
        }

        let removed = 0;
        for (const name of names) {
            if (keep.has(name)) continue;
            await fsp.rm(path.join(dir, name), { force: true });
            removed += 1;
        }
        return removed;
    }

    /** The manifest as rendered, or null if this chapter has never been done. */
    async manifest(story, chapter) {
        const dir = await audioDir(story, chapter);
        try {
            return JSON.parse(await fsp.readFile(path.join(dir, MANIFEST), 'utf8'));
        } catch (err) {
            if (err.code === 'ENOENT') return null;
            throw err;
        }
    }

    /**
     * Resolves one rendered file for serving. The name must be a bare hash
     * from our own naming scheme - never a path - so no request can walk out
     * of the audio folder.
     */
    async segmentPath(story, chapter, file) {
        if (!/^[a-f0-9]{16}\.wav$/.test(String(file || ''))) {
            throw new Error('That is not an audio segment.');
        }
        return path.join(await audioDir(story, chapter), file);
    }

    /** Throws away a chapter's audio entirely. */
    async clear(story, chapter) {
        const dir = await audioDir(story, chapter);
        await fsp.rm(dir, { recursive: true, force: true });
        return { cleared: true };
    }
}

async function exists(file) {
    try { await fsp.access(file); return true; } catch { return false; }
}

/** Reads duration straight out of a WAV header, without loading the audio. */
async function durationOf(file) {
    let handle;
    try {
        handle = await fsp.open(file, 'r');
        const head = Buffer.alloc(44);
        const { bytesRead } = await handle.read(head, 0, 44, 0);
        if (bytesRead < 44 || head.toString('ascii', 0, 4) !== 'RIFF') return null;

        const rate = head.readUInt32LE(24);
        const bytes = head.readUInt32LE(40);
        if (!rate || !bytes) return null;
        return { rate, seconds: bytes / 2 / rate };
    } catch {
        return null;
    } finally {
        await handle?.close();
    }
}

module.exports = new ChapterAudioService();
