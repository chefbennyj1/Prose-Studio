const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

/**
 * PiperVoices
 *
 * Which narrator voices exist, which are on this machine, and how to fetch one.
 *
 * Piper's own distribution is a Python package around a GPL-3.0 binary. None
 * of it is used here. A Piper voice is just a VITS model in ONNX form plus a
 * JSON config, and the engine that runs it (PiperService) is built out of
 * `onnxruntime-node` and `phonemizer`, both of which were already installed as
 * transitive dependencies of kokoro-js. So the voices are the only thing that
 * has to be downloaded, and nothing here is covered by that licence.
 *
 * The catalogue is fetched from Hugging Face rather than typed out. There are
 * 171 voices and their paths follow a convention that is easy to get subtly
 * wrong; the index is the authority, and a hardcoded list would rot the first
 * time one was renamed.
 */

const INDEX_URL = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/voices.json';
const FILE_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

// Beside the other downloaded models, and already in .gitignore. Voices run
// 20-120MB each and must never reach the repository.
const INSTALL_DIR = path.join(__dirname, '..', '..', 'ai_models', 'piper');

// The catalogue changes when someone contributes a voice, which is to say
// almost never. A day is generous and still costs one request.
const CATALOGUE_MS = 24 * 60 * 60 * 1000;

let catalogueCache = null;   // { at, voices }

/**
 * A voice id is used to build a filename, so it is held to the same standard
 * as a story name: it comes from our own catalogue, but it arrives over HTTP
 * from the browser and a caller could send anything.
 */
function isSafeId(id) {
    return typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id) && id.length < 120;
}

function assertSafeId(id) {
    if (!isSafeId(id)) throw new Error('That is not a valid voice name.');
    return id;
}

class PiperVoices {

    get directory() {
        return INSTALL_DIR;
    }

    /** Absolute path of the model file for a voice, installed or not. */
    pathFor(id) {
        return path.join(INSTALL_DIR, `${assertSafeId(id)}.onnx`);
    }

    async isInstalled(id) {
        if (!isSafeId(id)) return false;
        const model = this.pathFor(id);
        try {
            // Both halves or neither: a config without its model is a failed
            // download, and loading it would throw somewhere less obvious.
            await Promise.all([fsp.access(model), fsp.access(`${model}.json`)]);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * The speakers a voice carries, as [{ id, name }] in id order.
     *
     * Most voices are one person and answer with a single entry. Some are a
     * whole corpus: en_GB-vctk-medium holds 109 and en_US-libritts-high holds
     * 904, all in one file, reachable only by passing a speaker id at
     * synthesis time. Until there was a picker, every render in the app used
     * id 0 — which for VCTK is "p239", chosen by nothing but its position.
     *
     * Read from the config, never cached beyond the config itself: it is a few
     * KB and the model is not loaded to answer.
     */
    async speakers(id) {
        const config = JSON.parse(await fsp.readFile(`${this.pathFor(id)}.json`, 'utf8'));
        const map = config.speaker_id_map || {};

        const list = Object.entries(map).map(([name, sid]) => ({ id: sid, name }));
        if (!list.length) return [{ id: 0, name: 'default' }];

        return list.sort((a, b) => a.id - b.id);
    }

    async installed() {
        let names;
        try {
            names = await fsp.readdir(INSTALL_DIR);
        } catch (err) {
            if (err.code === 'ENOENT') return [];
            throw err;
        }

        const ids = names.filter(n => n.endsWith('.onnx')).map(n => n.slice(0, -5));
        const checked = await Promise.all(ids.map(async id => (await this.isInstalled(id)) ? id : null));
        return checked.filter(Boolean).sort();
    }

    /**
     * @returns {Promise<Array<{id, name, language, quality, speakers, files}>>}
     *
     * Throws if the index cannot be read. Callers that only need the installed
     * list should not be calling this - being offline must not stop a writer
     * rendering with a voice they already have.
     */
    async catalogue() {
        if (catalogueCache && (Date.now() - catalogueCache.at) < CATALOGUE_MS) {
            return catalogueCache.voices;
        }

        const res = await fetch(INDEX_URL, { signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`The voice list could not be fetched (${res.status}).`);
        const index = await res.json();

        const voices = Object.entries(index).map(([id, entry]) => ({
            id,
            name: entry.name,
            language: entry.language?.code || entry.language?.family || '',
            languageName: entry.language?.name_english || entry.language?.code || '',
            quality: entry.quality,
            speakers: entry.num_speakers || 1,
            model: Object.keys(entry.files || {}).find(f => f.endsWith('.onnx')),
            config: Object.keys(entry.files || {}).find(f => f.endsWith('.onnx.json')),
            bytes: Object.entries(entry.files || {})
                .find(([f]) => f.endsWith('.onnx'))?.[1]?.size_bytes || 0
        })).filter(v => v.model && v.config);

        catalogueCache = { at: Date.now(), voices };
        return voices;
    }

    /**
     * Downloads a voice's two files.
     *
     * Written to a .part file and renamed only once complete, because an
     * interrupted download that keeps the real name is worse than no download
     * at all: isInstalled() would say yes and the engine would fail on a
     * truncated model with an ONNX error that names no cause.
     */
    async install(id, onProgress) {
        assertSafeId(id);
        if (await this.isInstalled(id)) return { id, alreadyInstalled: true };

        const entry = (await this.catalogue()).find(v => v.id === id);
        if (!entry) throw new Error(`There is no voice called "${id}".`);

        await fsp.mkdir(INSTALL_DIR, { recursive: true });
        const model = this.pathFor(id);

        try {
            await this.#download(`${FILE_BASE}/${entry.model}`, model, entry.bytes, onProgress);
            await this.#download(`${FILE_BASE}/${entry.config}`, `${model}.json`, 0, null);
        } catch (err) {
            // Leave nothing half-installed behind.
            await fsp.rm(`${model}.part`, { force: true });
            await fsp.rm(model, { force: true });
            await fsp.rm(`${model}.json`, { force: true });
            throw err;
        }

        console.log(`[PiperVoices] Installed ${id}`);
        return { id, alreadyInstalled: false };
    }

    async #download(url, target, expectedBytes, onProgress) {
        const res = await fetch(url, { signal: AbortSignal.timeout(20 * 60 * 1000) });
        if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${path.basename(target)}.`);

        const total = Number(res.headers.get('content-length')) || expectedBytes || 0;
        let seen = 0;
        let lastReported = 0;

        const source = Readable.fromWeb(res.body);
        if (onProgress && total) {
            source.on('data', (chunk) => {
                seen += chunk.length;
                const percent = Math.round((seen / total) * 100);
                // Every whole percent at most: a 120MB file fires thousands of
                // data events and a socket emit per chunk would swamp the UI.
                if (percent > lastReported) {
                    lastReported = percent;
                    onProgress(percent);
                }
            });
        }

        const part = `${target}.part`;
        await pipeline(source, fs.createWriteStream(part));
        await fsp.rename(part, target);
    }

    async remove(id) {
        assertSafeId(id);
        const model = this.pathFor(id);
        await fsp.rm(model, { force: true });
        await fsp.rm(`${model}.json`, { force: true });
        return { id };
    }
}

module.exports = new PiperVoices();
