// views/dashboard/components/Narrator/MusicBed.js

/**
 * The music under the narrator.
 *
 * WHY NOT <audio loop>. Two things it cannot do, and both are audible under a
 * quiet drone:
 *
 *   1. Its loop is not gapless. Every browser inserts a small silence at the
 *      wrap, and a bed that stops for 40ms every few minutes reads as a fault
 *      rather than as music.
 *   2. Its volume can only be changed from a timer. setInterval runs on the
 *      main thread, behind layout and rendering, so a "fade" arrives in
 *      whatever steps the browser had time for - lumpy on a busy page, and the
 *      page is busy exactly when a chapter starts playing.
 *
 * Web Audio fixes both by moving the work onto the audio clock. Gain ramps are
 * scheduled ahead and executed sample-accurately whatever the main thread is
 * doing, and loops can be overlapped rather than butted together.
 *
 * THE LOOP IS CROSSFADED WITH ITSELF. Sample-accurate looping removes the gap
 * but not the jump: unless a track was composed to loop, its last bar does not
 * lead into its first and the seam is heard as an edit. So each pass is
 * scheduled to start LOOP_CROSSFADE seconds before the previous one ends, and
 * the two are faded across that overlap - the track dissolves into itself.
 * Ambient and drone material, which is what a bed under narration almost
 * always is, becomes genuinely seamless this way.
 *
 * Fades use an equal-power curve, not a straight line. Two uncorrelated
 * signals at half amplitude sum to less than either at full, so a linear
 * crossfade dips in the middle - the exact moment the seam is meant to be
 * hidden.
 */

const MUSIC_URL = '/api/narrator/music';

/** Overlap between one pass of the loop and the next. */
const LOOP_CROSSFADE = 2.5;

/** Crossfade when the writer picks a different track. */
const TRACK_CROSSFADE = 2.5;

/** Fade in when narration starts, out when it stops. */
const START_FADE = 1.2;
const STOP_FADE = 1.5;

/** How far ahead the next pass of the loop is queued. */
const SCHEDULE_AHEAD = 1.0;
const SCHEDULE_TICK = 250;

let context = null;
let master = null;          // everything the bed plays goes through this

let track = null;           // filename, or null
let volume = 0.12;          // quiet enough to sit under a voice
let running = false;        // should the bed be sounding right now

// The currently sounding layer: its own gain, so a track change can fade this
// one out while the next fades in through a gain of its own.
let layer = null;           // { gain, sources: Set, buffer, nextStart, timer }

const buffers = new Map();  // filename -> decoded AudioBuffer

/* ---------- context ---------- */

/**
 * Created lazily and only ever from a click, because a browser will not let an
 * AudioContext start without a gesture. Every caller here is a button.
 */
function ensureContext() {
    if (context) return context;

    context = new (window.AudioContext || window.webkitAudioContext)();
    master = context.createGain();
    master.gain.value = volume;
    master.connect(context.destination);
    return context;
}

/**
 * An equal-power crossfade curve. cos/sin rather than a straight line: two
 * uncorrelated signals at 0.5 sum to about 0.7 of full, so a linear fade
 * leaves a hole in the middle of the crossfade.
 */
/**
 * The same fade, arriving at a chosen level instead of at 1.
 *
 * RISE and FALL are normalised 0..1, so scheduling RISE on the master gain
 * ramped it to FULL gain and then relied on a setValueAtTime at the end of the
 * curve to snap it back down to the writer's volume - audible as a blip on
 * every resume, and the snap was also what threw:
 *
 *   NotSupportedError: setValueAtTime(0.12, 558.4625) overlaps
 *   setValueCurveAtTime(..., 558.0654, 0.4)
 *
 * Scaling the curve removes both problems at once. The fade ends where it
 * should, so nothing has to be scheduled at the join.
 */
function atPeak(curve, peak) {
    const out = new Float32Array(curve.length);
    for (let i = 0; i < curve.length; i++) out[i] = curve[i] * peak;
    return out;
}

/**
 * Clear the schedule, including a fade already in flight.
 *
 * cancelScheduledValues() only removes events at or after the given time - a
 * setValueCurveAtTime that has ALREADY STARTED stays registered, and anything
 * scheduled inside its window then throws. That is why the error only appeared
 * after a suspend and a resume close together, and why a page refresh made it
 * go away: a fresh AudioContext has nothing left over.
 *
 * cancelAndHoldAtTime truncates the running curve and holds its current value,
 * which is exactly what a fade being interrupted should do. Not in every
 * engine, so it falls back.
 */
function clearSchedule(param, now) {
    if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now);
    else param.cancelScheduledValues(now);
}

function fadeCurve(rising, steps = 64) {
    const curve = new Float32Array(steps);
    for (let i = 0; i < steps; i++) {
        const t = (i / (steps - 1)) * (Math.PI / 2);
        curve[i] = rising ? Math.sin(t) : Math.cos(t);
    }
    return curve;
}

const RISE = fadeCurve(true);
const FALL = fadeCurve(false);

/* ---------- loading ---------- */

async function bufferFor(name) {
    if (buffers.has(name)) return buffers.get(name);

    const res = await fetch(`${MUSIC_URL}/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`Could not load ${name}`);

    // decodeAudioData wants the whole file. A bed is a few MB and is played
    // for an hour, so decoding once and keeping it is the cheap way round.
    const decoded = await ensureContext().decodeAudioData(await res.arrayBuffer());
    buffers.set(name, decoded);
    return decoded;
}

/* ---------- one layer ---------- */

function makeLayer(buffer) {
    const gain = context.createGain();
    gain.gain.value = 0;
    gain.connect(master);
    return { gain, buffer, sources: new Set(), nextStart: 0, timer: null };
}

/**
 * Queues one pass of the loop, fading it in over the tail of the pass before
 * it and out into the pass after.
 */
function schedulePass(target, startAt) {
    const source = context.createBufferSource();
    source.buffer = target.buffer;

    const shape = context.createGain();
    source.connect(shape);
    shape.connect(target.gain);

    const duration = target.buffer.duration;
    const overlap = Math.min(LOOP_CROSSFADE, duration / 3);

    // In over the overlap, held, then out over the overlap at the end.
    shape.gain.setValueAtTime(0, startAt);
    shape.gain.setValueCurveAtTime(RISE, startAt, overlap);
    shape.gain.setValueAtTime(1, startAt + duration - overlap);
    shape.gain.setValueCurveAtTime(FALL, startAt + duration - overlap, overlap);

    source.start(startAt);
    source.stop(startAt + duration + 0.05);
    source.onended = () => {
        target.sources.delete(source);
        try { shape.disconnect(); } catch { /* already gone */ }
    };
    target.sources.add(source);

    // The next pass begins before this one ends; that overlap IS the seam.
    target.nextStart = startAt + duration - overlap;
}

/**
 * Keeps one pass queued ahead of the playhead. A single setInterval doing
 * scheduling is fine - it is not doing the fading, only deciding when the next
 * pass should start, and the audio clock handles the rest.
 */
function keepLooping(target) {
    clearInterval(target.timer);
    target.timer = setInterval(() => {
        if (!context || target !== layer) return;
        if (context.currentTime > target.nextStart - SCHEDULE_AHEAD) {
            schedulePass(target, target.nextStart);
        }
    }, SCHEDULE_TICK);
}

function retire(target, fade = TRACK_CROSSFADE) {
    if (!target) return;

    clearInterval(target.timer);
    const now = context.currentTime;
    target.gain.gain.cancelScheduledValues(now);
    target.gain.gain.setValueAtTime(target.gain.gain.value, now);
    target.gain.gain.setValueCurveAtTime(FALL, now, fade);

    // Let the fade finish on the audio clock before tearing anything down.
    setTimeout(() => {
        for (const source of target.sources) {
            try { source.stop(); } catch { /* already stopped */ }
        }
        target.sources.clear();
        try { target.gain.disconnect(); } catch { /* already gone */ }
    }, (fade + 0.2) * 1000);
}

/* ---------- public surface ---------- */

/**
 * @param {string|null} name  filename in the writer's music folder
 *
 * Crossfades if something is already playing. Takes effect immediately,
 * including mid-sentence: it is a mixing decision, and the only way to judge
 * one is against the narration actually running.
 */
export async function setTrack(name) {
    if (name === track) return;
    track = name || null;

    if (!track) {
        retire(layer);
        layer = null;
        return;
    }
    if (!running) return;       // it will start with the narration

    await swapTo(track);
}

async function swapTo(name) {
    let buffer;
    try {
        buffer = await bufferFor(name);
    } catch (err) {
        // The narration is the point; losing the bed is not worth stopping for.
        console.warn('[MusicBed]', err.message);
        return;
    }

    // The writer may have changed their mind while it downloaded.
    if (name !== track || !running) return;

    const outgoing = layer;
    const next = makeLayer(buffer);
    layer = next;

    const now = context.currentTime;
    const fade = outgoing ? TRACK_CROSSFADE : START_FADE;
    next.gain.gain.setValueAtTime(0, now);
    next.gain.gain.setValueCurveAtTime(RISE, now, fade);

    schedulePass(next, now);
    keepLooping(next);

    retire(outgoing, fade);
}

/** Narration has started. */
export async function start() {
    if (running) return;
    running = true;
    if (!track) return;

    ensureContext();
    if (context.state === 'suspended') await context.resume();

    // The master is only set when the context is made. A level changed while
    // stopped, or a pause's fade to silence followed by a stop, would
    // otherwise carry into this start. The layer fades in on its own gain, so
    // setting the master outright is not heard as a jump.
    const now = context.currentTime;
    clearSchedule(master.gain, now);
    master.gain.setValueAtTime(volume, now);

    await swapTo(track);
}

/** Narration paused. The bed holds its place rather than starting over. */
export async function suspend() {
    if (!running || !context) return;
    running = false;
    // Ramp the master down first so the suspend is not heard as a cut.
    const now = context.currentTime;
    // Falls from the level it is actually at. Unscaled, FALL starts at 1, so a
    // bed playing quietly would JUMP UP to full gain before fading out.
    clearSchedule(master.gain, now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.setValueCurveAtTime(atPeak(FALL, master.gain.value || volume), now, 0.4);
    setTimeout(() => { if (!running && context) context.suspend(); }, 450);
}

export async function resume() {
    if (running) return;
    running = true;
    if (!track) return;

    ensureContext();
    if (context.state === 'suspended') await context.resume();

    const now = context.currentTime;
    // Rises from wherever it actually is to the writer's volume, and stops
    // there - no event at the join, so nothing can overlap the curve.
    clearSchedule(master.gain, now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.setValueCurveAtTime(atPeak(RISE, volume), now, 0.4);

    if (!layer) await swapTo(track);
}

/** Narration stopped for good. */
export function stop() {
    running = false;
    if (!context) return;
    retire(layer, STOP_FADE);
    layer = null;
}

export function setVolume(next) {
    volume = Math.min(1, Math.max(0, Number(next) || 0));
    // Paused or stopped: resume() and start() rise to the new level on their
    // own. Ramping here would undo the fade-out a pause just scheduled.
    if (!context || !master || !running) return;

    const now = context.currentTime;
    // Not cancelScheduledValues - a resume curve may still be running, and
    // setValueAtTime inside its window throws. See clearSchedule.
    clearSchedule(master.gain, now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(volume, now + 0.25);
}

export function getState() {
    return { track, volume, running };
}
