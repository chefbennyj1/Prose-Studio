// views/dashboard/components/Narrator/narrator.worker.js

/**
 * Kokoro, off the main thread.
 *
 * This has to be a worker. Synthesis is seconds of solid compute per block,
 * and on the main thread it would freeze the writing surface every time the
 * narrator reached for the next paragraph. In here the writer keeps typing
 * while the voice runs behind them.
 *
 * The model loads once, lazily, on the first request. Nothing is downloaded
 * until somebody actually presses play.
 *
 * Requests carry a `run` number. When playback is stopped or restarted the
 * main thread bumps it, and anything already in flight for an older run is
 * dropped on return instead of arriving late and speaking over the top of
 * whatever is playing now.
 */

import { KokoroTTS } from '/libs/kokoro/kokoro.web.js';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

let model = null;
let loading = null;
let currentRun = 0;

// Kokoro is not reentrant; requests are serialised onto this chain so two
// blocks never generate at once.
let chain = Promise.resolve();

function post(message, transfer) {
    self.postMessage(message, transfer || []);
}

/** Keep this much after the last real sound, so nothing is clipped short. */
const TAIL_KEEP_MS = 30;

/**
 * Drops the quiet tail Kokoro leaves on the end of a chunk.
 *
 * The model pads its output, and that padding is not reliably silent - it can
 * carry low-level noise that is inaudible on its own but lands right where one
 * chunk butts against the next, which is exactly where a seam gets noticed.
 *
 * The threshold is relative to the chunk's own peak, because a quiet line of
 * dialogue and a shout have very different noise floors. If the scan claims
 * most of the chunk is silence the threshold is wrong, not the audio, so it
 * gives up rather than cutting into speech.
 */
function trimTail(samples, rate) {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
        const level = Math.abs(samples[i]);
        if (level > peak) peak = level;
    }
    if (!peak) return samples;

    const floor = Math.max(peak * 0.02, 0.005);
    let end = samples.length - 1;
    while (end > 0 && Math.abs(samples[end]) < floor) end -= 1;

    const keep = Math.min(samples.length, end + 1 + Math.round((TAIL_KEEP_MS / 1000) * rate));
    if (keep < samples.length * 0.5) return samples;

    return samples.subarray(0, keep);
}

function load(prefer) {
    if (loading) return loading;

    /*
     * WebGPU is picked when available - larger weights, far faster. But the
     * two backends are not numerically identical: ONNX Runtime's WebGPU
     * kernels can differ from the WASM ones, and that is a real candidate for
     * audio that degrades in ways no change to the input text affects.
     *
     * `prefer` forces one, so the two can be compared in the running editor
     * rather than argued about:
     *     localStorage.setItem('narrator_device', 'wasm')   // then reload
     *     localStorage.removeItem('narrator_device')        // back to auto
     */
    const gpu = typeof navigator !== 'undefined' && !!navigator.gpu;
    const device = prefer === 'wasm' || prefer === 'webgpu'
        ? prefer
        : (gpu ? 'webgpu' : 'wasm');
    const dtype = device === 'webgpu' ? 'fp32' : 'q8';

    post({ type: 'loading', device, dtype });

    loading = KokoroTTS.from_pretrained(MODEL, {
        dtype,
        device,
        progress_callback: (report) => {
            if (!report || typeof report.progress !== 'number') return;
            post({ type: 'progress', percent: Math.round(report.progress) });
        }
    }).then((loaded) => {
        model = loaded;
        post({ type: 'ready', device, dtype });
        return loaded;
    }).catch((err) => {
        // Clear the cache so a later attempt can retry rather than resolving
        // the same rejected promise forever.
        loading = null;
        post({ type: 'failed', message: err.message });
        throw err;
    });

    return loading;
}

async function speak(request) {
    if (request.run < currentRun) return;

    const engine = await load(request.device);
    if (request.run < currentRun) return;

    const result = await engine.generate(request.text, { voice: request.voice });
    if (request.run < currentRun) return;

    // Copied, not transferred.
    //
    // result.audio may be a view onto a larger buffer the model still owns and
    // reuses between calls. Transferring detaches that buffer out from under
    // it, and a view's tail is exactly where the damage would show - at the
    // end of every utterance. A copy of a few seconds of mono audio is cheap
    // next to synthesising it.
    const samples = new Float32Array(trimTail(result.audio, result.sampling_rate));

    post({
        type: 'audio',
        id: request.id,
        run: request.run,
        rate: result.sampling_rate,
        samples
    }, [samples.buffer]);
}

self.onmessage = (event) => {
    const message = event.data || {};

    if (message.type === 'load') {
        load(message.device).catch(() => { /* already reported as `failed` */ });
        return;
    }

    if (message.type === 'cancel') {
        currentRun = message.run;
        return;
    }

    if (message.type !== 'speak') return;

    chain = chain.then(() => speak(message)).catch((err) => {
        if (message.run < currentRun) return;
        post({ type: 'error', id: message.id, run: message.run, message: err.message });
    });
};
