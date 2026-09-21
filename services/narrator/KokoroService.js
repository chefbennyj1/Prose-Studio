// services/narrator/KokoroService.js

/**
 * The Kokoro narrator: 82M parameters, on the CPU, in this process.
 *
 * Piper is fast and flat. It is VITS, it renders far quicker than real time,
 * and on a long stretch of narrated fiction it sounds like a machine reading
 * rather than a person telling. Kokoro is a larger model with markedly better
 * prosody, and it runs on the same onnxruntime the Piper voices already use —
 * no Python, no PyTorch, no GPU.
 *
 * It was ALREADY INSTALLED. kokoro-js has been in package.json since before the
 * narrator was built, unused: PiperService was assembled out of its transitive
 * dependencies (onnxruntime-node and phonemizer) and the library itself was
 * never called. It and @huggingface/transformers were ~148MB of a 269MB
 * installer, shipped and never loaded. So this costs nothing that was not
 * already being paid.
 *
 * ## One model, many voices
 *
 * Unlike Piper, where each voice is its own 20-120MB file, Kokoro is a single
 * model carrying every voice as a small embedding. Installing "a Kokoro voice"
 * means fetching that one model; the rest are then free. The catalogue below
 * reflects that: they are all installed or none of them are.
 *
 * ## Ids are namespaced
 *
 * `kokoro:af_heart` rather than `af_heart`, so a voice id says which engine
 * should speak it and the two catalogues cannot collide. Nothing outside this
 * file and the router needs to know the difference.
 */

const path = require('path');

const PREFIX = 'kokoro:';

// q8 on the CPU: about 80MB and quick enough to render a chapter, where fp32 is
// four times the download for a difference nobody listening to a draft will
// hear. dtype is the one knob worth revisiting if the voices disappoint.
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DTYPE = 'q8';

let tts = null;
let loading = null;

/** Beside the Piper voices, in the writer's own folder — never inside the asar. */
function cacheDir() {
    const store = require('../db/Store');
    return path.join(path.dirname(store.dir), 'voices', 'kokoro');
}

/**
 * Loads the model once.
 *
 * The promise is cached rather than the result, so two paragraphs rendered at
 * the same moment wait on one download instead of starting two.
 */
async function engine() {
    if (tts) return tts;
    if (loading) return loading;

    loading = (async () => {
        /*
         * Point the cache at the writer's folder BEFORE the model is asked for.
         *
         * Transformers.js defaults to `node_modules/@huggingface/transformers/
         * .cache`, which inside a packaged app is a path in a read-only archive
         * — the download would simply fail, the same way the Piper voices did.
         *
         * It has to be @huggingface/transformers' own env. kokoro-js exports an
         * `env` too, and it is a DIFFERENT object carrying only wasmPaths;
         * setting cacheDir on that silently does nothing, which is exactly what
         * it did here — the model went into node_modules and the code looked
         * correct while doing it.
         */
        const { env } = await import('@huggingface/transformers');
        env.cacheDir = cacheDir();

        const { KokoroTTS } = await import('kokoro-js');
        tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: DTYPE, device: 'cpu' });
        return tts;
    })();

    try {
        return await loading;
    } finally {
        loading = null;
    }
}

class KokoroService {

    /** Does this id belong to this engine? */
    owns(id) {
        return typeof id === 'string' && id.startsWith(PREFIX);
    }

    /** `kokoro:af_heart` -> `af_heart` */
    bare(id) {
        return String(id).slice(PREFIX.length);
    }

    /** Whether the model has been fetched. */
    async isInstalled() {
        const fsp = require('fs').promises;
        try {
            const entries = await fsp.readdir(cacheDir(), { recursive: true });
            return entries.some(name => String(name).endsWith('.onnx'));
        } catch {
            return false;
        }
    }

    async ready() {
        return this.isInstalled();
    }

    /**
     * Every voice the model carries, in the shape the voice list already uses.
     *
     * Listing requires the model, because the voice table lives inside it. With
     * nothing downloaded yet the known names are returned instead, so the
     * writer can see what they would be getting before committing to a download.
     */
    async catalogue() {
        const installed = await this.isInstalled();

        if (installed) {
            try {
                const model = await engine();
                return Object.entries(model.list_voices ? model.list_voices() : {}).map(([id, meta]) => ({
                    id: PREFIX + id,
                    name: meta?.name || id,
                    language: meta?.language || 'en',
                    languageName: meta?.language === 'en-gb' ? 'English (GB)' : 'English (US)',
                    quality: 'kokoro',
                    speakers: 1,
                    gender: meta?.gender || '',
                    engine: 'kokoro',
                    bytes: 0
                }));
            } catch {
                // Fall through to the static list rather than showing nothing.
            }
        }

        return KNOWN.map(v => ({ ...v, id: PREFIX + v.id, engine: 'kokoro', speakers: 1, bytes: 0 }));
    }

    /**
     * Fetches the model. The progress callback is shared with the Piper
     * installer so the dashboard's progress bar needs no special case.
     */
    async install(_id, onProgress) {
        if (await this.isInstalled()) return { alreadyInstalled: true };
        if (onProgress) onProgress(1);
        await engine();
        if (onProgress) onProgress(100);
        return { installed: true };
    }

    /** One model behind every voice, so removing one removes them all. */
    async remove() {
        const fsp = require('fs').promises;
        tts = null;
        await fsp.rm(cacheDir(), { recursive: true, force: true });
        return { removed: true };
    }

    async unload() {
        tts = null;
    }

    /** Kokoro voices are single-speaker; the picker asks every engine. */
    async speakers() {
        return [{ id: 0, name: 'default' }];
    }

    /**
     * Speaks, in exactly the shape PiperService.speak returns, so every caller
     * — the preview, the chapter renderer, the export — works unchanged.
     *
     * @returns {Promise<{audio: Float32Array, sampleRate: number, chunks: number}>}
     */
    async speak(id, text, opts = {}) {
        const clean = String(text || '').trim();
        const model = await engine();

        if (!clean) return { audio: new Float32Array(0), sampleRate: 24000, chunks: 0 };

        const result = await model.generate(clean, {
            voice: this.bare(id),
            // Piper exposes pace as lengthScale, where >1 is slower. Kokoro
            // takes speed, where >1 is faster, so the two are reciprocal.
            speed: opts.lengthScale ? 1 / Number(opts.lengthScale) : 1
        });

        return {
            audio: result.audio instanceof Float32Array ? result.audio : Float32Array.from(result.audio),
            sampleRate: result.sampling_rate || 24000,
            chunks: 1
        };
    }
}

/**
 * The voices this model is known to carry, for the list shown before anything
 * has been downloaded. The model is the authority once it is here; this only
 * has to be close enough to choose from.
 */
const KNOWN = [
    { id: 'af_heart', name: 'Heart', language: 'en-us', languageName: 'English (US)', quality: 'kokoro', gender: 'female' },
    { id: 'af_bella', name: 'Bella', language: 'en-us', languageName: 'English (US)', quality: 'kokoro', gender: 'female' },
    { id: 'af_nicole', name: 'Nicole', language: 'en-us', languageName: 'English (US)', quality: 'kokoro', gender: 'female' },
    { id: 'af_sarah', name: 'Sarah', language: 'en-us', languageName: 'English (US)', quality: 'kokoro', gender: 'female' },
    { id: 'am_michael', name: 'Michael', language: 'en-us', languageName: 'English (US)', quality: 'kokoro', gender: 'male' },
    { id: 'am_adam', name: 'Adam', language: 'en-us', languageName: 'English (US)', quality: 'kokoro', gender: 'male' },
    { id: 'bf_emma', name: 'Emma', language: 'en-gb', languageName: 'English (GB)', quality: 'kokoro', gender: 'female' },
    { id: 'bf_isabella', name: 'Isabella', language: 'en-gb', languageName: 'English (GB)', quality: 'kokoro', gender: 'female' },
    { id: 'bm_george', name: 'George', language: 'en-gb', languageName: 'English (GB)', quality: 'kokoro', gender: 'male' },
    { id: 'bm_lewis', name: 'Lewis', language: 'en-gb', languageName: 'English (GB)', quality: 'kokoro', gender: 'male' }
];

module.exports = new KokoroService();
module.exports.PREFIX = PREFIX;
