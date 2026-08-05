// views/dashboard/components/Narrator/Narrator.js

/**
 * The narrator: synthesis pipelined against playback.
 *
 * Nothing waits for the whole chapter. Block one starts playing the moment it
 * is ready while block two is already being synthesised behind it, and because
 * Kokoro runs faster than realtime the queue keeps pulling ahead of the ear.
 * The only wait a writer ever sees is the first block, which is why the first
 * couple of blocks are single sentences (see planLive).
 *
 * LOOKAHEAD is the whole buffering policy. Synthesising further ahead than
 * this wastes work the moment somebody stops or edits; less than this and a
 * slow machine runs the queue dry mid-sentence. If synthesis genuinely cannot
 * keep up we say "buffering" and wait, the way a video player does, rather
 * than stuttering through the gaps.
 */

import { planLive, CHUNK_GAP, PARAGRAPH_GAP, SCENE_GAP } from './prepare.js';

/**
 * How far ahead of the ear to synthesise. Chunks are capped small now (see
 * MAX_CHARS), so this is a handful of seconds of audio, not minutes of wasted
 * work if the writer stops.
 */
const LOOKAHEAD = 5;

/**
 * How much has to be ready before the first word is spoken.
 *
 * Starting on the very first chunk meant playback set off with nothing behind
 * it, and any hesitation in synthesis was immediately audible. Waiting for a
 * few chunks costs a second or two once and buys a cushion that lasts the
 * whole reading. Only applies to the start - once running, playback resumes
 * the moment the next chunk lands.
 */
const PREBUFFER = 3;

let worker = null;
let context = null;
let source = null;
let gapTimer = null;

// Bumped on every stop and every start. Anything tagged with an older run is
// discarded on arrival, so a slow block cannot speak over a newer one.
let run = 0;

let plan = [];
let buffers = new Map();
let nextRequest = 0;
let nextPlay = 0;

let state = 'idle';

// PREBUFFER gates the first block only; after that a dry queue resumes on the
// next arrival rather than waiting for the cushion to refill.
let started = false;

let voice = 'af_bella';
let lexicon = null;
let modelState = 'cold';
let handlers = {};

function emit(name, ...args) {
    const fn = handlers[name];
    if (typeof fn === 'function') fn(...args);
}

function setState(next) {
    if (state === next) return;
    state = next;
    emit('onState', state);
}

/* ---------- worker ---------- */

function ensureWorker() {
    if (worker) return worker;

    worker = new Worker('/views/dashboard/components/Narrator/narrator.worker.js', { type: 'module' });
    worker.onmessage = (event) => onWorkerMessage(event.data || {});

    /**
     * A module worker that cannot resolve its imports fails with an ErrorEvent
     * carrying no message at all, so "Worker failed: undefined" is all you get
     * and it tells you nothing. The overwhelmingly likely cause is the Kokoro
     * bundle not being served, so go and look before reporting.
     */
    worker.onerror = async (event) => {
        let detail = event.message || '';

        if (!detail) {
            const res = await fetch('/libs/kokoro/kokoro.web.js', { method: 'HEAD' }).catch(() => null);
            detail = res && res.ok
                ? 'the worker script would not start'
                : 'the Kokoro bundle is not being served at /libs/kokoro/. The server needs restarting to pick up the static mount added in server.js.';
        }

        console.error('[Narrator] Worker failed:', detail);
        modelState = 'failed';
        emit('onModel', { state: 'failed', message: detail });
        stop();
    };

    return worker;
}

function onWorkerMessage(message) {
    if (message.type === 'loading') {
        modelState = 'loading';
        emit('onModel', { state: 'loading', device: message.device, dtype: message.dtype });
        return;
    }

    if (message.type === 'progress') {
        emit('onModel', { state: 'downloading', percent: message.percent });
        return;
    }

    if (message.type === 'ready') {
        modelState = 'ready';
        emit('onModel', { state: 'ready', device: message.device, dtype: message.dtype });
        return;
    }

    if (message.type === 'failed') {
        modelState = 'failed';
        emit('onModel', { state: 'failed', message: message.message });
        stop();
        return;
    }

    if (message.run !== run) return;   // stale: a newer run has taken over

    if (message.type === 'error') {
        console.error('[Narrator] Synthesis failed:', message.message);
        emit('onError', message.message);
        stop();
        return;
    }

    if (message.type !== 'audio') return;

    buffers.set(message.id, { samples: message.samples, rate: message.rate });
    pump();

    if (source || gapTimer) return;

    // Nothing is playing. Start only once the cushion is there - or once there
    // is nothing left to wait for, on a passage shorter than the cushion.
    const ready = readyAhead();
    if (started || ready >= PREBUFFER || nextPlay + ready >= plan.length) {
        playNext();
        return;
    }

    reportBuffering(ready);
}

/**
 * The wait before the first word is the only one the listener sits through, so
 * it says how far along it is rather than just that it is busy.
 */
function reportBuffering(ready) {
    emit('onBuffering', {
        ready,
        needed: Math.min(PREBUFFER, Math.max(1, plan.length - nextPlay))
    });
}

/** How many consecutive blocks from the playhead are already synthesised. */
function readyAhead() {
    let count = 0;
    while (buffers.has(nextPlay + count)) count += 1;
    return count;
}

/* ---------- the pipeline ---------- */

/**
 * Keep exactly LOOKAHEAD blocks in flight or waiting ahead of the playhead.
 * Silence blocks never go to the worker; there is nothing to synthesise.
 */
function pump() {
    while (nextRequest < plan.length && (nextRequest - nextPlay) <= LOOKAHEAD) {
        const block = plan[nextRequest];

        if (block.kind === 'break') {
            buffers.set(nextRequest, { silence: SCENE_GAP });
        } else {
            ensureWorker().postMessage({
                type: 'speak',
                id: nextRequest,
                run,
                text: block.text,
                voice,
                device: devicePreference()
            });
        }

        nextRequest += 1;
    }
}

function playNext() {
    if (nextPlay >= plan.length) {
        setState('idle');
        emit('onFinished');
        return;
    }

    const entry = buffers.get(nextPlay);
    if (!entry) {
        // The queue ran dry. Wait for the worker rather than skipping a block.
        setState('buffering');
        return;
    }

    buffers.delete(nextPlay);
    const index = nextPlay;
    const taggedRun = run;
    nextPlay += 1;
    pump();

    started = true;
    setState('playing');

    if (entry.silence) {
        gapTimer = setTimeout(() => {
            gapTimer = null;
            if (taggedRun !== run) return;
            playNext();
        }, entry.silence * 1000);
        return;
    }

    // The gap is padded onto the end of the block instead of being timed
    // separately: the audio graph handles it exactly, a timer would not.
    //
    // Only a block that ends a paragraph gets a paragraph's pause. The others
    // are pieces of one paragraph, split to keep each generate() inside the
    // length Kokoro handles cleanly, and pausing between them would invent a
    // break the writer never wrote.
    const rate = entry.rate;
    const gap = plan[index].endsParagraph ? PARAGRAPH_GAP : CHUNK_GAP;
    const padding = Math.round(gap * rate);
    const buffer = context.createBuffer(1, entry.samples.length + padding, rate);
    buffer.copyToChannel(entry.samples, 0, 0);

    source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => {
        if (taggedRun !== run) return;
        source = null;
        playNext();
    };
    source.start();

    emit('onBlock', { index, total: plan.length, text: plan[index].text || '' });
}

/* ---------- public surface ---------- */

export function initNarrator(callbacks = {}) {
    handlers = callbacks;
}

export function setVoice(next) {
    voice = next;
}

/** Word -> respelling, applied on the way to the voice. See applyLexicon. */
export function setLexicon(next) {
    lexicon = next && typeof next === 'object' ? next : null;
}

/**
 * Speaks one word on its own, for tuning a respelling by ear. Deliberately
 * bypasses the lexicon: you are auditioning the replacement itself, so
 * substituting it again would test the wrong string.
 */
export function speakWord(text) {
    stop();
    plan = [{ kind: 'text', text: String(text || '').trim(), endsParagraph: true }];
    if (!plan[0].text) return false;

    if (!context) context = new (window.AudioContext || window.webkitAudioContext)();
    if (context.state === 'suspended') context.resume();

    buffers = new Map();
    nextRequest = 0;
    nextPlay = 0;
    started = false;

    setState('buffering');
    pump();
    return true;
}

export function getVoice() {
    return voice;
}

export function isActive() {
    return state === 'playing' || state === 'buffering';
}

/**
 * Which backend to run on, or null to let the worker choose.
 *
 * An escape hatch rather than a setting: the two backends are not numerically
 * identical, so being able to force one is how you find out whether an audio
 * fault belongs to the GPU path.
 *     localStorage.setItem('narrator_device', 'wasm')   // then reload
 *     localStorage.removeItem('narrator_device')        // back to auto
 */
function devicePreference() {
    try {
        return localStorage.getItem('narrator_device') || null;
    } catch {
        return null;
    }
}

/** Download the model without speaking, so the first press of play is quick. */
export function warmUp() {
    ensureWorker().postMessage({ type: 'load', device: devicePreference() });
}

/**
 * @param {string} markdown  raw manuscript text, Markdown and all
 */
export function start(markdown) {
    stop();

    plan = planLive(markdown, lexicon).filter(block => block.kind !== 'text' || block.text.trim());
    if (!plan.length) return false;

    // Created on the click that starts playback: browsers refuse to run an
    // AudioContext that was not opened by a user gesture.
    if (!context) context = new (window.AudioContext || window.webkitAudioContext)();
    if (context.state === 'suspended') context.resume();

    buffers = new Map();
    nextRequest = 0;
    nextPlay = 0;
    started = false;

    setState('buffering');
    pump();
    reportBuffering(0);
    return true;
}

export function stop() {
    run += 1;
    if (worker) worker.postMessage({ type: 'cancel', run });

    if (source) {
        source.onended = null;
        try { source.stop(); } catch { /* already ended */ }
        source = null;
    }

    if (gapTimer) {
        clearTimeout(gapTimer);
        gapTimer = null;
    }

    buffers.clear();
    plan = [];
    nextRequest = 0;
    nextPlay = 0;
    started = false;
    setState('idle');
}

export function modelStatus() {
    return modelState;
}
