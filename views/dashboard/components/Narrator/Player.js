// views/dashboard/components/Narrator/Player.js

/**
 * Plays a rendered chapter: a list of paragraph files, in order, with the
 * silences between them.
 *
 * This replaced synthesising during playback. The old browser narrator had to
 * run a model fast enough to stay ahead of the ear, which meant a lookahead
 * queue, a prebuffer, a "buffering" state and a run counter to stop stale
 * audio speaking over new. None of that is needed once the audio already
 * exists: this is a playlist, and the hard problems are gone rather than
 * solved.
 *
 * Silence is a timer, not a file. A scene break is 1.2 seconds of nothing, and
 * shipping 1.2 seconds of zeroes over HTTP to represent it would be absurd.
 *
 * The one thing worth care is the seam between paragraphs. An <audio> element
 * that is handed a src at the moment the previous one ends will stall for the
 * length of a network round trip, which is audible. So the next segment is
 * created and told to preload the moment the current one starts, and by the
 * time it is needed it is usually already in memory. Segments are served
 * immutable and named after a hash of their own audio, so a second listen is
 * served from the browser cache with no request at all.
 */

import * as bed from './MusicBed.js';

const SEGMENT_URL = '/api/narrator/audio/segment';

let manifest = null;
let story = null;
let chapter = null;

let index = 0;
let current = null;      // the <audio> now playing
let upcoming = null;     // preloaded next
let gapTimer = null;

// Bumped on every stop and load. A timer or an 'ended' handler that belongs to
// an older run is ignored, so a paragraph cannot resume a chapter that is no
// longer open.
let run = 0;

let playing = false;
let handlers = {};

function emit(name, ...args) {
    const fn = handlers[name];
    if (typeof fn === 'function') fn(...args);
}

function urlFor(file) {
    return `${SEGMENT_URL}/${encodeURIComponent(file)}` +
        `?story=${encodeURIComponent(story)}&chapter=${encodeURIComponent(chapter)}`;
}

/** Indexes of the entries that actually make sound, for "paragraph 3 of 12". */
function spokenPositions() {
    const positions = [];
    manifest?.segments.forEach((s, i) => { if (s.kind === 'text') positions.push(i); });
    return positions;
}

export function init(callbacks = {}) {
    handlers = callbacks;
}

/* ---------- the music bed ---------- */

/*
 * The bed lives in MusicBed.js, on the Web Audio clock. It used to be an
 * <audio loop> faded by setInterval here, and neither half of that survived
 * contact with a quiet drone: the loop had an audible gap at the wrap, and the
 * "fade" was as smooth as the main thread happened to be. See that file.
 *
 * All this layer does is tie it to the transport, because the bed follows the
 * narration - it starts with it, holds its place through a pause, and fades
 * out at the end rather than stopping dead.
 */

export function setMusic(track, volume) {
    if (typeof volume === 'number') bed.setVolume(volume);
    bed.setTrack(track || null);
}

/** Level only. setMusic would hand the bed its track again. */
export function setMusicLevel(volume) {
    bed.setVolume(volume);
}

export function getMusic() {
    return bed.getState();
}

/**
 * @returns {boolean} false when this chapter has never been rendered, which
 *                    the caller shows as "Render" rather than as an error.
 */
export async function load(nextStory, nextChapter) {
    stop();

    story = nextStory;
    chapter = nextChapter;
    manifest = null;
    index = 0;

    if (!story || !chapter) return false;

    try {
        const res = await fetch(`/api/narrator/audio/manifest` +
            `?story=${encodeURIComponent(story)}&chapter=${encodeURIComponent(chapter)}`);
        const data = await res.json();
        manifest = data.ok ? data.manifest : null;
    } catch {
        manifest = null;
    }

    emit('onLoaded', summary());
    return !!manifest;
}

export function summary() {
    if (!manifest) return null;
    return {
        voice: manifest.voice,
        seconds: manifest.seconds,
        paragraphs: spokenPositions().length,
        renderedAt: manifest.renderedAt
    };
}

export function isPlaying() {
    return playing;
}

export function isLoaded() {
    return !!manifest;
}

/**
 * @param {number} [from]  index into manifest.segments; playback starts at the
 *                         first spoken entry at or after it.
 */
export function play(from) {
    if (!manifest) return false;

    if (typeof from === 'number') {
        index = from;
    } else if (index >= manifest.segments.length) {
        index = 0;                      // finished last time: start again
    }

    playing = true;
    emit('onState', 'playing');
    bed.start();
    step();
    return true;
}

export function pause() {
    if (!playing) return;
    playing = false;

    // Paused mid-paragraph resumes mid-paragraph; the element keeps its
    // position and the index still points at this entry.
    current?.pause();
    bed.suspend();
    clearTimeout(gapTimer);
    gapTimer = null;
    emit('onState', 'paused');
}

export function toggle() {
    if (playing) { pause(); return false; }
    resume();
    return true;
}

function resume() {
    if (!manifest) return;
    playing = true;
    emit('onState', 'playing');

    // The bed resumes where it was, so a pause does not restart the music.
    bed.resume();

    // Mid-paragraph: carry on rather than restarting it.
    if (current && !current.ended && current.currentTime > 0) {
        current.play().catch(() => { /* the user can press play again */ });
        return;
    }
    step();
}

export function stop() {
    run += 1;
    playing = false;

    if (current) {
        current.onended = null;
        current.onerror = null;
        current.pause();
        current.src = '';
        current = null;
    }

    upcoming = null;
    clearTimeout(gapTimer);
    gapTimer = null;
    index = 0;
    bed.stop();

    emit('onState', 'idle');
}

/** Skips to the next or previous spoken paragraph. */
export function skip(direction) {
    if (!manifest) return;

    const positions = spokenPositions();
    const at = positions.findIndex(p => p >= index);
    const now = at === -1 ? positions.length - 1 : at;
    const target = positions[Math.min(positions.length - 1, Math.max(0, now + direction))];

    if (target === undefined) return;

    const wasPlaying = playing;
    haltCurrent();
    index = target;

    if (wasPlaying) step();
    else emit('onSegment', describe(index));
}

function haltCurrent() {
    run += 1;
    if (current) {
        current.onended = null;
        current.onerror = null;
        current.pause();
        current = null;
    }
    clearTimeout(gapTimer);
    gapTimer = null;
}

function describe(at) {
    const segment = manifest.segments[at];
    const positions = spokenPositions();
    return {
        index: at,
        position: positions.indexOf(at) + 1,
        total: positions.length,
        text: segment?.text || '',
        seconds: segment?.seconds || 0
    };
}

/** Plays whatever is at `index`, then moves on. */
function step() {
    if (!playing || !manifest) return;

    if (index >= manifest.segments.length) {
        playing = false;
        index = 0;
        bed.stop();
        emit('onState', 'idle');
        emit('onFinished');
        return;
    }

    const segment = manifest.segments[index];
    const tagged = run;

    if (segment.kind === 'break') {
        index += 1;
        gapTimer = setTimeout(() => {
            if (tagged !== run) return;
            step();
        }, (segment.seconds || 0) * 1000);
        return;
    }

    emit('onSegment', describe(index));

    const audio = upcoming && upcoming.dataset.file === segment.file
        ? upcoming
        : new Audio(urlFor(segment.file));
    upcoming = null;

    audio.dataset.file = segment.file;
    current = audio;

    audio.onended = () => {
        if (tagged !== run) return;
        index += 1;
        // The pause after a paragraph, which the render deliberately did not
        // bake into the audio.
        gapTimer = setTimeout(() => {
            if (tagged !== run) return;
            step();
        }, (segment.gap || 0) * 1000);
    };

    audio.onerror = () => {
        if (tagged !== run) return;
        // One missing file must not end the chapter: the likely cause is a
        // sweep during a re-render, and the rest is still there.
        console.warn('[Player] Segment would not play:', segment.file);
        index += 1;
        step();
    };

    audio.play().catch((err) => {
        if (tagged !== run) return;
        playing = false;
        emit('onState', 'idle');
        emit('onError', err.message);
    });

    preloadNext();
}

/**
 * Fetches the next paragraph while this one plays, so the seam between them is
 * the silence we chose rather than a network round trip.
 */
function preloadNext() {
    const next = manifest.segments
        .slice(index + 1)
        .find(s => s.kind === 'text');
    if (!next) return;

    const audio = new Audio();
    audio.preload = 'auto';
    audio.dataset.file = next.file;
    audio.src = urlFor(next.file);
    upcoming = audio;
}
