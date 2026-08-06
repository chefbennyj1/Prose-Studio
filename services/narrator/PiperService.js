const fs = require('fs');
const fsp = fs.promises;
const ort = require('onnxruntime-node');
const PiperVoices = require('./PiperVoices');

/**
 * PiperService
 *
 * Text in, audio samples out, entirely on this machine.
 *
 * Piper ships as a Python package wrapping a GPL-3.0 binary, and neither is
 * used. A Piper voice is a VITS model in ONNX form whose input is a list of
 * espeak-ng phoneme ids, and both halves of that were already installed here
 * as transitive dependencies of kokoro-js:
 *
 *   onnxruntime-node   runs the model
 *   phonemizer         is espeak-ng compiled to WASM
 *
 * So this adds no dependency, no native binary and no Python, and the only
 * thing downloaded is the voice itself.
 *
 * The input format is taken from each voice's own config rather than assumed:
 *
 *   ids    = [BOS, PAD, p1, PAD, p2, PAD, ..., EOS]   pad between every phoneme
 *   scales = [noise_scale, length_scale, noise_w]     from config.inference
 *
 * TRUNCATION. Not every voice will take a whole paragraph. Measured on this
 * machine, en_US-lessac-medium renders a four-sentence paragraph complete
 * (0.97 of the same sentences rendered separately and summed) while
 * en_US-ryan-high returns 0.61 of it - it drops roughly 40% of the prose and
 * reports no error at all. Silently losing a writer's sentences is the worst
 * thing this service could do, so every synthesis is checked against what the
 * voice's own measured pace says it should be, and a short one is re-rendered
 * sentence by sentence. See calibrate() and #looksTruncated().
 */

/**
 * Voices are 20-120MB of weights each and stay resident once loaded. Two is
 * enough to audition one voice against another without holding a whole shelf
 * of them in memory.
 */
const MAX_LOADED = 2;

/**
 * Short, ordinary, and fully punctuated - it must never itself be truncated,
 * because everything else is judged against the pace it establishes.
 */
const CALIBRATION_TEXT = 'The house at the end of the lane had been empty for years.';

/**
 * Silence between sentences inside a paragraph, in seconds.
 *
 * This exists because of how a VITS model reads a run of sentences. Handed a
 * whole paragraph in one pass it treats a mid-paragraph full stop as a
 * continuation: the pause is short and the pitch stays up, which is heard as
 * the narrator never finishing a sentence. Rendered one at a time, each
 * sentence is a complete utterance and the pitch lands - measured on
 * en_US-lessac-medium, the last 300ms falls 25-36% below the middle of the
 * sentence, on every sentence rather than only the last one in the paragraph.
 *
 * Doing it this way also puts the pause under our control instead of the
 * model's. Raise this for a slower, more deliberate read.
 *
 * The cost is prosody across a sentence boundary, which the model can no
 * longer carry. That is a real loss and it is the reason this was not done
 * first; it turned out to matter far less than the sentences landing.
 */
const SENTENCE_GAP = 0.35;

/**
 * Extra silence added to each pause INSIDE a sentence - the commas, the
 * semicolons, the dashes. Piper's own comma is short enough to read as a
 * stumble rather than a breath.
 *
 * Smaller than SENTENCE_GAP on purpose. A comma must be clearly less than a
 * full stop or the sentence stops sounding like one continuous thought, which
 * is the entire difference a comma is making.
 */
const COMMA_BREATH = 0.18;

/**
 * How far under the predicted length counts as truncated.
 *
 * Real speech varies with punctuation and phrasing, so a little under is
 * normal; 40% under is not. A false positive costs one re-render and cannot
 * corrupt the output, because the fallback result is only used when it is
 * actually longer - see speak().
 */
const TRUNCATION_RATIO = 0.75;

const loaded = new Map();   // id -> { session, config, secondsPerId, chunkBySentence }

// Configs are a few KB and are wanted without the weights: the pronunciation
// editor phonemizes on every keystroke and must not drag a model in with it.
const configs = new Map();  // id -> parsed .onnx.json

let phonemizeFn = null;

async function phonemizer() {
    if (phonemizeFn) return phonemizeFn;
    // ESM-only, and this file is CommonJS.
    const mod = await import('phonemizer');
    phonemizeFn = mod.phonemize;
    return phonemizeFn;
}

const { splitSentences } = require('./TextPlan');

class PiperService {

    /** Is any voice installed? Answers without loading one. */
    async ready() {
        return (await PiperVoices.installed()).length > 0;
    }

    async unload(id) {
        const entry = loaded.get(id);
        if (!entry) return;
        loaded.delete(id);
        try { await entry.session.release(); } catch { /* already gone */ }
    }

    async #load(id) {
        const cached = loaded.get(id);
        if (cached) return cached;

        if (!(await PiperVoices.isInstalled(id))) {
            throw new Error(`The voice "${id}" is not installed.`);
        }

        const model = PiperVoices.pathFor(id);
        const config = JSON.parse(await fsp.readFile(`${model}.json`, 'utf8'));
        const session = await ort.InferenceSession.create(model);

        const entry = { id, session, config, secondsPerId: null, chunkBySentence: false };

        // Evict before inserting, so MAX_LOADED is a ceiling on what is
        // resident rather than one more than it.
        while (loaded.size >= MAX_LOADED) {
            await this.unload(loaded.keys().next().value);
        }
        loaded.set(id, entry);

        await this.#calibrate(entry);
        console.log(`[PiperService] Loaded ${id} (${config.audio.sample_rate}Hz, ` +
            `${entry.secondsPerId.toFixed(4)}s per phoneme id)`);
        return entry;
    }

    /**
     * Establishes what this voice's normal pace is, on a sentence short enough
     * that it cannot have been cut short. Everything longer is measured
     * against it.
     */
    async #calibrate(entry) {
        const { ids } = await this.#toIds(entry, CALIBRATION_TEXT);
        const audio = await this.#run(entry, ids);
        entry.secondsPerId = (audio.length / entry.config.audio.sample_rate) / ids.length;
    }

    /**
     * Phonemes for one passage, WITH its punctuation.
     *
     * The punctuation is the whole reason this is not a one-line call. The
     * phonemizer package splits its input on punctuation and returns the
     * clauses with every mark thrown away:
     *
     *   "He stopped. She did not, and he knew it."
     *     -> ["hiː stˈɑːpt", "ʃiː dˈɪd nˌɑːt", "ænd hiː nˈuː ɪt"]
     *
     * Joining those with spaces - which is what this used to do - hands Piper
     * an unbroken stream of words. The model has ids for `. , ; : ! ?` and
     * uses them to place pauses and clause-final intonation, so without them
     * it reads a paragraph as one long run-on breath. That is audible as "no
     * pauses and no feeling", and it was not the voice's fault.
     *
     * So the text is split on the marks first, each run is phonemized on its
     * own, and the marks are put back between them. Splitting first also turns
     * out to be several times FASTER than one whole-paragraph call.
     *
     * Only the clause marks go back in. Quotes and brackets have ids too, but
     * espeak never emits them, so a Piper voice has almost certainly never
     * seen one during training and feeding it an unseen token is a gamble with
     * no upside. Dashes and ellipses fold onto the nearest mark that does
     * work, because in prose they are pauses and the alternative is dropping
     * them silently.
     */
    async #toIds(entry, text) {
        const map = entry.config.phoneme_id_map;
        const phonemize = await phonemizer();
        const phonemes = await phonemesFor(phonemize, entry.config.espeak.voice, text);

        const ids = [...map['^'], ...map['_']];
        let unknown = 0;
        for (const ch of phonemes) {
            if (!map[ch]) { unknown += 1; continue; }
            ids.push(...map[ch], ...map['_']);
        }
        ids.push(...map['$']);
        return { ids, phonemes, unknown };
    }

    async #run(entry, ids, opts = {}) {
        const inf = entry.config.inference;
        const feeds = {
            input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
            input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
            scales: new ort.Tensor('float32', Float32Array.from([
                opts.noiseScale ?? inf.noise_scale,
                opts.lengthScale ?? inf.length_scale,
                opts.noiseW ?? inf.noise_w
            ]), [3])
        };

        if (entry.config.num_speakers > 1) {
            feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(opts.speaker ?? 0)]), [1]);
        }

        const out = await entry.session.run(feeds);
        const data = out[Object.keys(out)[0]].data;
        return data instanceof Float32Array ? data : Float32Array.from(data);
    }

    #looksTruncated(entry, ids, audio) {
        if (!entry.secondsPerId) return false;
        const seconds = audio.length / entry.config.audio.sample_rate;
        return seconds < ids.length * entry.secondsPerId * TRUNCATION_RATIO;
    }

    /**
     * @param {string} id     installed voice id
     * @param {string} text   one paragraph, usually
     * @param {object} opts   lengthScale > 1 slows the narrator down;
     *                        sentenceGap overrides the pause between sentences
     * @returns {Promise<{audio: Float32Array, sampleRate: number, chunks: number}>}
     *
     * Always one sentence per pass. See SENTENCE_GAP for why.
     */
    async speak(id, text, opts = {}) {
        const entry = await this.#load(id);
        const sampleRate = entry.config.audio.sample_rate;

        const clean = String(text || '').trim();
        if (!clean) return { audio: new Float32Array(0), sampleRate, chunks: 0 };

        const gap = opts.sentenceGap ?? SENTENCE_GAP;
        const sentences = splitSentences(clean);
        const pieces = [];

        for (const sentence of sentences) {
            const { ids } = await this.#toIds(entry, sentence);
            let audio = await this.#run(entry, ids, opts);

            // A single sentence is short enough that no voice truncates it -
            // but a very long one still can, and the guard is cheap.
            if (this.#looksTruncated(entry, ids, audio)) {
                console.warn(`[PiperService] ${id} truncated a sentence of ${ids.length} ids.`);
            }

            if (pieces.length) pieces.push(new Float32Array(Math.round(gap * sampleRate)));
            pieces.push(breathe(trimTail(audio, sampleRate), sampleRate,
                opts.commaBreath ?? COMMA_BREATH));
        }

        return { audio: concat(pieces), sampleRate, chunks: sentences.length };
    }

    /**
     * What the voice will actually say, for tuning a pronunciation by eye.
     *
     * Deliberately does NOT load the model. This runs on every keystroke in
     * the pronunciation editor, and phonemization needs only the espeak voice
     * name out of the config - building a 63MB ONNX session and calibrating it
     * to render a line of text would put a two-second stall behind each letter
     * typed, on the first use after a restart.
     */
    async phonemesFor(id, text) {
        const config = await this.#config(id);
        const phonemize = await phonemizer();
        return phonemesFor(phonemize, config.espeak.voice, text);
    }

    /** The voice's JSON config, without its weights. Cached; it is a few KB. */
    async #config(id) {
        const loaded = configs.get(id);
        if (loaded) return loaded;

        if (!(await PiperVoices.isInstalled(id))) {
            throw new Error(`The voice "${id}" is not installed.`);
        }

        const config = JSON.parse(await fsp.readFile(`${PiperVoices.pathFor(id)}.json`, 'utf8'));
        configs.set(id, config);
        return config;
    }
}

/**
 * The marks Piper places a pause on. These are the ones espeak itself emits as
 * clause separators, which is to say the ones a voice was trained with.
 */
const CLAUSE_MARKS = ',.;:!?';
const CLAUSE_SPLIT = /([,.;:!?])/;

/**
 * Typographic marks folded onto a clause mark that the voice understands.
 * An em dash is a pause in prose; dropping it loses the pause entirely, and
 * the map's own `-` is trained as a hyphen inside words rather than a break.
 */
const FOLD = {
    '—': ',',   // em dash
    '–': ',',   // en dash
    '…': '.',   // ellipsis
    '“': '', '”': '',   // smart quotes: espeak drops them, so do we
    '‘': "'", '’': "'"  // smart apostrophes are part of the word
};

async function phonemesFor(phonemize, espeakVoice, text) {
    const normalised = [...String(text || '')].map(c => (c in FOLD ? FOLD[c] : c)).join('');

    let out = '';
    for (const token of normalised.split(CLAUSE_SPLIT)) {
        if (token.length === 1 && CLAUSE_MARKS.includes(token)) {
            out += `${token} `;
            continue;
        }

        const words = token.trim();
        if (!words) continue;

        const parts = await phonemize(words, espeakVoice);
        if (out && !/\s$/.test(out)) out += ' ';
        out += parts.join(' ');
    }

    out = out.replace(/ {2,}/g, ' ').trim();

    // A passage that ends without a mark leaves the model with no cue that the
    // utterance is over, and it trails off rather than landing. Cheap to add
    // and inaudible as anything but a cadence.
    return out && !CLAUSE_MARKS.includes(out.slice(-1)) ? `${out}.` : out;
}

/**
 * Lengthens the pauses inside a sentence - the commas, semicolons and dashes.
 *
 * A comma is a breath, and Piper's is short. It cannot be fixed by splitting
 * on commas the way sentences are split: a comma pause is INSIDE a sentence,
 * and each fragment rendered alone would take a sentence-final falling
 * intonation. "She put the letter down." "and looked out at the rain." - two
 * statements where the writer wrote one breath.
 *
 * Nor can it be fixed by feeding the model more pause tokens. Measured: two
 * extra tokens per comma gave 6.71s, four gave 6.77s, six gave 6.55s - SHORTER
 * - and nine gave 7.11s. VITS predicts duration; it does not concatenate, so
 * asking louder does not reliably get more.
 *
 * So the sentence is synthesised whole, with its prosody intact, and the
 * silence the model already placed is stretched afterwards. Which gap belongs
 * to which comma never has to be worked out: any quiet stretch this long in
 * the middle of a sentence IS punctuation. A stop consonant closure - the shut
 * mouth before a p, t or k - runs 50-100ms, so the threshold sits above it and
 * those are left alone.
 */
function breathe(samples, rate, extra, minPause = 0.12) {
    if (extra <= 0) return samples;

    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    if (!peak) return samples;

    const floor = peak * 0.04;
    const minRun = Math.round(minPause * rate);
    const pad = Math.round(extra * rate);

    // Find the quiet runs, ignoring anything touching either end: leading and
    // trailing silence are the caller's business, not a breath.
    const runs = [];
    let start = -1;
    for (let i = 0; i < samples.length; i++) {
        const quiet = Math.abs(samples[i]) < floor;
        if (quiet && start === -1) start = i;
        if (!quiet && start !== -1) {
            if (i - start >= minRun && start > 0) runs.push([start, i]);
            start = -1;
        }
    }
    if (!runs.length) return samples;

    const out = new Float32Array(samples.length + runs.length * pad);
    let read = 0;
    let write = 0;
    for (const [from, to] of runs) {
        // Everything up to the middle of the gap, then the extra silence.
        const middle = Math.floor((from + to) / 2);
        out.set(samples.subarray(read, middle), write);
        write += middle - read;
        write += pad;                       // Float32Array is already zeroed
        read = middle;
    }
    out.set(samples.subarray(read), write);
    return out.subarray(0, write + (samples.length - read));
}

/**
 * Drops the near-silent tail the model leaves after the last sound, so the gap
 * between two sentences is the gap we chose and not that plus whatever padding
 * each one happened to come with.
 *
 * Keeps 30ms, which is enough that nothing is clipped, and gives up rather
 * than cutting if the scan claims most of the audio is silence - that would
 * mean the threshold is wrong, not the speech.
 */
function trimTail(samples, rate) {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
        const level = Math.abs(samples[i]);
        if (level > peak) peak = level;
    }
    if (!peak) return samples;

    const floor = Math.max(peak * 0.02, 0.004);
    let end = samples.length - 1;
    while (end > 0 && Math.abs(samples[end]) < floor) end -= 1;

    const keep = Math.min(samples.length, end + 1 + Math.round(0.03 * rate));
    return keep < samples.length * 0.5 ? samples : samples.subarray(0, keep);
}

function concat(buffers) {
    const total = buffers.reduce((sum, b) => sum + b.length, 0);
    const out = new Float32Array(total);
    let at = 0;
    for (const b of buffers) { out.set(b, at); at += b.length; }
    return out;
}

module.exports = new PiperService();
