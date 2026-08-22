// services/narrator/ExportService.js

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const Storage = require('../StorageService');
const ManuscriptService = require('../manuscript/ManuscriptService');
const DictionaryService = require('../proofing/DictionaryService');
const ChapterAudio = require('./ChapterAudioService');
const GeminiVoice = require('./GeminiVoiceService');
const { planChapter } = require('./TextPlan');
const { findQuotes, splitParagraphs } = require('../proofing/MechanicsText');

/**
 * ExportService
 *
 * The finished take: a chapter performed by the Gemini voice and written to a
 * folder you can hand to a video editor.
 *
 *     <story>/export/chapter_01/
 *         chapter.wav      the whole chapter, one file, gaps included
 *         timestamps.txt   YouTube-ready chapter markers
 *         manifest.json    what was rendered, from what, and how much it cost
 *         parts/           one wav per paragraph, hash-named
 *
 * WHY A SEPARATE FOLDER FROM .audio, AND NOT A SECOND VOICE INSIDE IT.
 *
 * ChapterAudioService sweeps: any file in its folder that the current manifest
 * does not reference is deleted, which is what stops a chapter revised twenty
 * times keeping every version. Rendering a second engine into the same folder
 * would therefore make each engine delete the other's work on every render.
 * Two products, two folders, no sweep collision - and `.audio` stays exactly
 * as it is, which is the point: Piper's player must not change because this
 * arrived.
 *
 * `export/` is NOT hidden, unlike `.audio`. It is the thing being made; you
 * have to be able to find it in Explorer without being told about dotfiles.
 * It still lives inside the story folder, so moving or deleting a story takes
 * its audio with it.
 *
 * RESUMABLE, because the free tier is metered by requests per day rather than
 * by money. A chapter is two hundred-odd paragraphs and the daily allowance
 * will run out partway. So a quota error is not a failure here: the renderer
 * stops politely, keeps every paragraph already rendered, writes what it has,
 * and says how many are left. Tomorrow's run skips them by hash and carries on
 * where it stopped. A chapter over three days, free, rather than a bill.
 */

const EXPORT_DIR = 'export';
const PARTS_DIR = 'parts';
const MANIFEST = 'manifest.json';

/** Matches ChapterAudioService, so the two products sound structurally alike. */
const PARAGRAPH_GAP = 0.75;
const SCENE_GAP = 1.6;

/**
 * Part of every segment hash. Raise it when a change here makes the SAME text
 * produce DIFFERENT audio, or every existing part stays cached and the fix is
 * invisible. See the same note in ChapterAudioService.
 *
 *   1  first release
 */
const RENDER_VERSION = 1;

/**
 * The engine, the voice, the DIRECTION and the text.
 *
 * The style prompt has to be in here. It is the whole reason this engine
 * exists, and it changes the performance completely while leaving the words
 * alone - so a hash without it would serve yesterday's reading of a paragraph
 * you have just re-directed, and nothing on screen would say why the change
 * did nothing.
 */
function hashFor(model, voice, style, text) {
    return crypto.createHash('sha1')
        .update(`v${RENDER_VERSION} gemini ${model} ${voice} ${style} ${text}`)
        .digest('hex')
        .slice(0, 16);
}

/**
 * THE NUMBER IS THE CHAPTER'S OWN, NOT ITS POSITION IN THE FOLDER.
 *
 * This first shipped as `index + 1` - the chapter's place in listChapters -
 * and it was wrong the moment a story contained anything that was not a
 * chapter. listChapters returns EVERY non-hidden .md in the story folder, so
 * an outline, a synopsis or a character sheet sorting ahead of the prose takes
 * a slot and shifts everything after it. Ben's chapter 2 came out as
 * chapter_03, with chapter 2's audio correctly inside it.
 *
 * A writer means their own numbering, so read it off the name when the name
 * declares one: "Chapter 2", "2. The Water", "02 - Rain". Anything else -
 * "First Light", "Room 101" - has no number to read, and position is the only
 * answer left.
 *
 * Deliberately NOT any digit anywhere in the name: a chapter called "Room 101"
 * is not chapter 101.
 */
function declaredNumber(name) {
    const found = /^\s*(?:chapter\s*)?(\d{1,3})\b/i.exec(String(name || ''));
    return found ? Number(found[1]) : null;
}

/**
 * Zero-padded, because a file manager sorts chapter_10 before chapter_2 and a
 * folder of chapters in the wrong order is the kind of thing that gets noticed
 * at the point of assembling a video.
 *
 * @param {Array}  chapters  listChapters output, in order
 * @param {number} index     which one is being exported
 */
function folderFor(chapters, index) {
    const declared = declaredNumber(chapters[index]?.name);

    /*
     * Two chapters claiming the same number would put two different chapters
     * in one folder and silently overwrite a finished render. Position is a
     * poor label but it is a unique one, so the later claimant loses.
     */
    const taken = declared !== null && chapters.some((c, i) =>
        i < index && declaredNumber(c.name) === declared);

    const number = (declared !== null && !taken) ? declared : index + 1;
    return `chapter_${String(number).padStart(2, '0')}`;
}

async function exportDir(story, folder) {
    const root = await Storage.requireStoryRoot();
    if (!Storage.isSafeSegment(story)) throw new Error('Invalid story name.');

    const dir = path.join(root, story, EXPORT_DIR, folder);
    const relative = path.relative(root, dir);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('That location is outside the story folder.');
    }
    return dir;
}

class ExportService {

    /**
     * What a render would do, without doing any of it.
     *
     * The point is to answer "what will this cost me" BEFORE anything is
     * spent: the chapter is already on disk, so the paragraph count and the
     * character count are known for free. Cached parts are already paid for.
     */
    async plan(story, chapter, options = {}) {
        const { style = '', voice = GeminiVoice.defaultVoice, model = GeminiVoice.defaultModel } = options;

        const chapters = await ManuscriptService.listChapters(story);
        const index = chapters.findIndex(c => c.name === chapter);
        if (index === -1) throw new Error(`There is no chapter called "${chapter}" in ${story}.`);

        const [{ text }, lexicon] = await Promise.all([
            ManuscriptService.read(story, chapter),
            DictionaryService.lexicon(story)
        ]);

        const folder = folderFor(chapters, index);
        await migrateFolders(story, chapters);

        const dir = await exportDir(story, folder);
        const parts = path.join(dir, PARTS_DIR);

        const segments = [];
        for (const block of planChapter(text, lexicon)) {
            if (block.kind !== 'text') {
                segments.push({ kind: 'break', seconds: SCENE_GAP });
                continue;
            }
            const body = block.text.trim();
            if (!body) continue;

            const hash = hashFor(model, voice, style, body);
            segments.push({
                kind: 'text',
                hash,
                file: `${hash}.wav`,
                text: body,
                gap: PARAGRAPH_GAP,
                cached: await exists(path.join(parts, `${hash}.wav`))
            });
        }

        const speech = segments.filter(s => s.kind === 'text');
        const pending = speech.filter(s => !s.cached);

        return {
            index,
            folder,
            dir,
            segments,
            total: speech.length,
            cached: speech.length - pending.length,
            pending: pending.length,
            characters: speech.reduce((n, s) => n + s.text.length, 0),
            pendingCharacters: pending.reduce((n, s) => n + s.text.length, 0)
        };
    }

    /**
     * Render what today allows.
     *
     * @param {object}   options
     * @param {string}   options.style     the direction, e.g. "noir, cyberpunk, English accent"
     * @param {string}   options.voice     prebuilt voice name
     * @param {string}   options.model     TTS model id
     * @param {number}   options.limit     stop after this many NEW paragraphs
     * @param {function} options.onProgress ({done, total, cached, stopped})
     *
     * Returns whether it finished or stopped, and how much is left. Stopping is
     * a normal outcome, not an error.
     */
    async render(story, chapter, options = {}) {
        const started = Date.now();
        const { style = '', voice = GeminiVoice.defaultVoice, model = GeminiVoice.defaultModel,
            limit = Infinity, onProgress } = options;

        /*
         * Checked once, here, before any work: a render that is going to be
         * refused should be refused now and not on paragraph one, after the
         * folder has been made and the writer has been told it started.
         * GeminiVoice.speak still checks for itself - it is public - and the
         * duplication costs a local database read per paragraph.
         */
        const available = await GeminiVoice.availability();
        if (!available.ok) throw new Error(available.reason);

        const plan = await this.plan(story, chapter, { style, voice, model });
        const parts = path.join(plan.dir, PARTS_DIR);
        await fsp.mkdir(parts, { recursive: true });

        let done = 0;
        let rendered = 0;
        let tokens = 0;
        let sampleRate = 0;
        let stopped = null;
        let stoppedMessage = null;

        for (const segment of plan.segments) {
            if (segment.kind !== 'text') continue;

            const target = path.join(parts, segment.file);

            if (segment.cached) {
                const known = await durationOf(target);
                if (known) {
                    segment.seconds = known.seconds;
                    sampleRate = sampleRate || known.rate;
                    done += 1;
                    onProgress?.({ done, total: plan.total, cached: true });
                    continue;
                }
                segment.cached = false;   // unreadable; render it again
            }

            if (rendered >= limit) {
                stopped = 'limit';
                break;
            }

            let audio;
            try {
                audio = await GeminiVoice.speak(voice, segment.text, { style, model });
            } catch (err) {
                /*
                 * Out of allowance. Everything rendered so far is on disk and
                 * hashed, so tomorrow's run costs nothing for it. This is the
                 * whole reason the loop is written this way.
                 */
                if (err.code === 'TTS_QUOTA') {
                    stopped = 'quota';
                    // Carried back rather than logged and lost: it says WHEN
                    // the allowance resets, which is the one thing the writer
                    // needs in order to know when to press it again.
                    stoppedMessage = err.message;
                    break;
                }
                throw err;
            }

            sampleRate = audio.sampleRate;
            tokens += audio.tokens || 0;

            // Written under a temporary name first: a half-written wav carrying
            // a real hash would be a valid cache hit for ever after.
            const partial = `${target}.part`;
            await fsp.writeFile(partial, ChapterAudio.wav(audio.audio, audio.sampleRate));
            await fsp.rename(partial, target);

            segment.seconds = audio.audio.length / audio.sampleRate;
            rendered += 1;
            done += 1;
            onProgress?.({ done, total: plan.total, cached: false });
        }

        const complete = plan.segments
            .filter(s => s.kind === 'text')
            .every(s => typeof s.seconds === 'number');

        // Only stitch a chapter that is actually whole. Half a chapter written
        // to chapter.wav is a file that looks finished and is not.
        let stitched = null;
        if (complete) {
            stitched = await this.#stitch(plan, parts, sampleRate);
        }

        const manifest = {
            version: 1,
            engine: 'gemini',
            model, voice, style,
            story, chapter,
            folder: plan.folder,
            sampleRate,
            complete,
            rendered,
            tokens,
            seconds: stitched?.seconds ?? null,
            renderedAt: Date.now(),
            segments: plan.segments.map(s => s.kind === 'text'
                ? { kind: 'text', file: `${PARTS_DIR}/${s.file}`, seconds: s.seconds ?? null, gap: s.gap, text: s.text.slice(0, 120) }
                : { kind: 'break', seconds: s.seconds })
        };
        await fsp.writeFile(path.join(plan.dir, MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');

        const remaining = plan.total - done;
        console.log(`[ExportService] ${story}/${chapter} -> ${plan.folder}: ` +
            `${rendered} rendered, ${done - rendered} reused, ${remaining} left, ` +
            `${tokens} tokens, ${((Date.now() - started) / 1000).toFixed(1)}s` +
            (stopped ? ` (stopped: ${stopped})` : ''));

        return {
            folder: plan.folder, dir: plan.dir,
            total: plan.total, done, rendered, remaining,
            tokens, complete, stopped, stoppedMessage,
            chapterFile: stitched?.file || null,
            seconds: stitched?.seconds ?? null
        };
    }

    /**
     * Every paragraph into one file, with the silences between them.
     *
     * The gaps are inserted here rather than baked into each part, so changing
     * the pacing costs a re-stitch (seconds, free) instead of a re-render
     * (money). Same reasoning as the manifest gaps in ChapterAudioService.
     */
    async #stitch(plan, parts, sampleRate) {
        const pieces = [];
        const marks = [];
        let elapsed = 0;

        const silence = (seconds) => {
            const samples = new Float32Array(Math.round(seconds * sampleRate));
            pieces.push(samples);
            elapsed += seconds;
        };

        /*
         * A scene break REPLACES the paragraph gap, it does not stack on top
         * of it. Adding both made every scene break 2.35s when the constant
         * says 1.6, which quietly broke the ranking the two values exist to
         * express - paragraph longer than sentence, scene longer than
         * paragraph - by making the gap depend on which side of a break you
         * were on rather than on what it meant.
         */
        let first = true;
        let afterBreak = false;
        for (const segment of plan.segments) {
            if (segment.kind === 'break') {
                silence(SCENE_GAP);
                afterBreak = true;
                continue;
            }
            if (!first && !afterBreak) silence(segment.gap);
            afterBreak = false;
            first = false;

            const wav = await fsp.readFile(path.join(parts, segment.file));
            const samples = pcmFromWav(wav);
            marks.push({ at: elapsed, text: segment.text.slice(0, 60) });
            pieces.push(samples);
            elapsed += samples.length / sampleRate;
        }

        const total = pieces.reduce((n, p) => n + p.length, 0);
        const all = new Float32Array(total);
        let offset = 0;
        for (const piece of pieces) { all.set(piece, offset); offset += piece.length; }

        const file = path.join(plan.dir, 'chapter.wav');
        await fsp.writeFile(file, ChapterAudio.wav(all, sampleRate));

        /*
         * YouTube reads "0:00 Title" lines out of a description and turns them
         * into chapter markers. The manifest already knows where every
         * paragraph starts, so this costs nothing and saves scrubbing through
         * an hour of audio to find them.
         */
        const stamps = marks.map(m => `${clock(m.at)} ${m.text.replace(/\s+/g, ' ')}`).join('\n');
        await fsp.writeFile(path.join(plan.dir, 'timestamps.txt'), stamps + '\n', 'utf8');

        return { file, seconds: elapsed };
    }

    /**
     * What has been rendered so far, stitched in memory, for listening.
     *
     * Stops at the FIRST paragraph that is not rendered rather than skipping
     * over the holes. The renderer works in order, so in practice those are the
     * same set - but if a hole ever did appear mid-chapter, splicing across it
     * would produce a jump cut that sounds like a fault in the writing rather
     * than a gap in the render. Contiguous from the top is always honest: this
     * is the opening of the chapter, exactly as it will be.
     *
     * Nothing is written to disk. `chapter.wav` remains the finished article
     * and only appears when the chapter is genuinely complete.
     */
    async preview(story, chapter, options = {}) {
        const plan = await this.plan(story, chapter, options);
        const parts = path.join(plan.dir, PARTS_DIR);

        const pieces = [];
        let sampleRate = 0;
        let paragraphs = 0;
        let seconds = 0;
        let first = true;

        let afterBreak = false;
        for (const segment of plan.segments) {
            if (segment.kind === 'break') {
                // Only carry a scene break through if prose follows it; a
                // preview should not end on 1.6 seconds of silence.
                if (!first) { pieces.push({ gap: SCENE_GAP }); afterBreak = true; }
                continue;
            }
            if (!segment.cached) break;

            const wav = await fsp.readFile(path.join(parts, segment.file)).catch(() => null);
            if (!wav) break;

            if (!sampleRate) sampleRate = wav.readUInt32LE(24);
            // A scene break replaces the paragraph gap - see #stitch.
            if (!first && !afterBreak) pieces.push({ gap: segment.gap });
            afterBreak = false;
            first = false;

            const samples = pcmFromWav(wav);
            pieces.push({ samples });
            seconds += samples.length / (sampleRate || 24000);
            paragraphs += 1;
        }

        if (!paragraphs) return { buffer: null, paragraphs: 0, total: plan.total, seconds: 0 };

        // Trailing gaps are silence nobody asked for.
        while (pieces.length && pieces[pieces.length - 1].gap) pieces.pop();

        const total = pieces.reduce((n, p) =>
            n + (p.samples ? p.samples.length : Math.round(p.gap * sampleRate)), 0);
        const all = new Float32Array(total);
        let offset = 0;
        for (const piece of pieces) {
            if (piece.samples) {
                all.set(piece.samples, offset);
                offset += piece.samples.length;
            } else {
                offset += Math.round(piece.gap * sampleRate);   // already zeroed
            }
        }

        return {
            buffer: ChapterAudio.wav(all, sampleRate),
            paragraphs,
            total: plan.total,
            seconds: all.length / sampleRate,
            complete: paragraphs === plan.total
        };
    }

    /**
     * The chapter's speakable paragraphs, flagged for whether they contain
     * dialogue. For auditioning a direction against a real line.
     *
     * Dialogue detection is MechanicsText's, the same routine the overuse scan
     * uses to keep a character's speech out of the author's tic count. One
     * definition of "in quotes" across the app; a second would eventually
     * disagree with the first.
     */
    async paragraphs(story, chapter) {
        const [{ text }, lexicon] = await Promise.all([
            ManuscriptService.read(story, chapter),
            DictionaryService.lexicon(story)
        ]);

        const out = [];
        for (const block of planChapter(text, lexicon)) {
            if (block.kind !== 'text') continue;
            const body = block.text.trim();
            if (!body) continue;

            const spans = findQuotes(body, splitParagraphs(body));
            out.push({
                index: out.length,
                text: body,
                hasDialogue: spans.length > 0,
                characters: body.length
            });
        }
        return out;
    }

    /** Where the export folder for a story is, whether or not it exists yet. */
    async folder(story) {
        const root = await Storage.requireStoryRoot();
        if (!Storage.isSafeSegment(story)) throw new Error('Invalid story name.');
        return path.join(root, story, EXPORT_DIR);
    }
}

/**
 * Move export folders left by the old position-based numbering.
 *
 * The first release named folders by a chapter's place among every .md in the
 * story, so a story with an outline in it produced chapter_03 for chapter 2.
 * Fixing the naming alone would ORPHAN that audio: the parts cache lives under
 * the folder, so a renamed scheme makes finished paragraphs look unrendered and
 * the writer pays to synthesise them a second time. Renaming the folder is the
 * difference between a cosmetic fix and an expensive one.
 *
 * Each folder's own manifest records the chapter it was rendered FROM, so the
 * correct new name is derivable without guessing from the folder name.
 *
 * Runs from plan(), which is called before every render and by the menu, so it
 * happens once and quietly. Deliberately conservative:
 *   - a folder with no readable manifest is left alone; it cannot be identified
 *   - a folder whose chapter no longer exists is left alone; it is the only
 *     copy of something and deleting or moving it is not this function's call
 *   - an occupied destination is never overwritten
 */
async function migrateFolders(story, chapters) {
    let root;
    try {
        root = path.join(await Storage.requireStoryRoot(), story, EXPORT_DIR);
    } catch {
        return;
    }

    let names;
    try {
        names = await fsp.readdir(root);
    } catch {
        return;   // nothing exported yet
    }

    const wanted = new Map();
    chapters.forEach((c, i) => wanted.set(c.name, folderFor(chapters, i)));

    for (const name of names) {
        if (!/^chapter_\d+$/.test(name)) continue;

        let manifest;
        try {
            manifest = JSON.parse(await fsp.readFile(path.join(root, name, MANIFEST), 'utf8'));
        } catch {
            continue;
        }

        const target = wanted.get(manifest.chapter);
        if (!target || target === name) continue;

        const to = path.join(root, target);
        if (await exists(to)) {
            console.warn(`[ExportService] Would move ${name} -> ${target} for "${manifest.chapter}", ` +
                `but ${target} already exists. Left alone.`);
            continue;
        }

        await fsp.rename(path.join(root, name), to);
        console.log(`[ExportService] Renamed ${name} -> ${target} ("${manifest.chapter}")`);
    }
}

async function exists(file) {
    try { await fsp.access(file); return true; } catch { return false; }
}

/** 0:00 up to an hour, 1:02:03 past it - the format YouTube parses. */
function clock(seconds) {
    const whole = Math.floor(seconds);
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    return h
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`;
}

/** Samples back out of one of our own 44-byte-header wavs. */
function pcmFromWav(buffer) {
    const bytes = buffer.readUInt32LE(40);
    const count = Math.floor(bytes / 2);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = buffer.readInt16LE(44 + i * 2) / 32768;
    return out;
}

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

module.exports = new ExportService();
