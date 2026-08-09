// views/dashboard/components/Narrator/voices.js

/**
 * Which voice narrates, remembered between sessions.
 *
 * One voice, not two. An earlier version of this file kept a separate "reading
 * voice" and "audiobook voice" because the two were different engines - a free
 * local one for playback and a paid cloud one for rendering - and letting one
 * setting drive both would have meant paying to hear every line played back
 * during an evening's editing.
 *
 * That split is gone with ElevenLabs. Piper is local, free and fast enough to
 * render faster than it plays, so the same voice reads a paragraph back and
 * renders the finished chapter, and there is nothing to decide between them.
 *
 * The voice id is stored, not the whole record. The catalogue is fetched
 * anyway to know what is installed, and a stale copy of a display name saved
 * here would eventually disagree with it.
 */

const VOICE_KEY = 'narrator_voice';
const SPEED_KEY = 'narrator_length_scale';
const ON_SAVE_KEY = 'narrator_render_on_save';
const MUSIC_KEY = 'narrator_music_track';

/**
 * Piper's length_scale, where 1 is the voice's trained pace and larger is
 * slower.
 *
 * The trained pace is NOT the right default for a book. Measured on
 * en_US-lessac-medium, length_scale 1 reads at about 222 words a minute;
 * audiobook narration sits at 150-160, and anything past roughly 190 is heard
 * as rushed. It was, immediately and by everyone who listened to it.
 *
 * 1.45 lands near 169 wpm - a shade brisk, which suits a novel being read back
 * to its own author more than a bedtime pace would. The scale is part of every
 * segment hash, so changing it re-renders by itself.
 */
const DEFAULT_SPEED = 1.45;
const MIN_SPEED = 1;
const MAX_SPEED = 2;

function read(key) {
    try {
        return localStorage.getItem(key);
    } catch {
        // Private browsing, or storage disabled. A forgotten preference is a
        // small annoyance; a narrator that will not start is not.
        return null;
    }
}

function write(key, value) {
    try {
        if (value === null || value === undefined || value === '') localStorage.removeItem(key);
        else localStorage.setItem(key, String(value));
    } catch { /* see read() */ }
}

/** @returns {string|null} null means nothing chosen yet, not a bad value. */
export function getVoice() {
    return read(VOICE_KEY);
}

export function setVoice(id) {
    write(VOICE_KEY, id || null);
    return id || null;
}

export function getSpeed() {
    const raw = Number(read(SPEED_KEY));
    if (!Number.isFinite(raw) || raw < MIN_SPEED || raw > MAX_SPEED) return DEFAULT_SPEED;
    return raw;
}

export function setSpeed(value) {
    const speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, Number(value) || DEFAULT_SPEED));
    write(SPEED_KEY, speed);
    return speed;
}

/* ---------- speaker, on multi-speaker voices ---------- */

const SPEAKER_KEY = 'narrator_speakers';

/**
 * Which speaker within a voice, remembered PER VOICE.
 *
 * A speaker is an index into one model's own roster, so it does not travel:
 * id 0 is "p239" in en_GB-vctk-medium and somebody else entirely in
 * en_US-libritts-high. Carrying one number across a voice change would land
 * the writer on an unrelated stranger, so each voice keeps its own choice and
 * gets it back when you return to it.
 *
 * Defaults to 0, which is what every render did before there was a picker -
 * not a recommendation, just the first row of the table.
 */
export function getSpeaker(voice) {
    if (!voice) return 0;
    try {
        const all = JSON.parse(read(SPEAKER_KEY) || '{}');
        const id = Number(all[voice]);
        return Number.isInteger(id) && id >= 0 ? id : 0;
    } catch {
        return 0;
    }
}

export function setSpeaker(voice, id) {
    if (!voice) return 0;
    const chosen = Number.isInteger(Number(id)) && Number(id) >= 0 ? Number(id) : 0;
    try {
        const all = JSON.parse(read(SPEAKER_KEY) || '{}');
        all[voice] = chosen;
        write(SPEAKER_KEY, JSON.stringify(all));
    } catch { /* see read() */ }
    return chosen;
}

/* ---------- music bed ---------- */

/**
 * Filename of the background track, or null for none. Only the name is kept;
 * the folder is the server's business and the file may be gone by next time,
 * which the picker handles by simply not listing it.
 */
export function getMusicTrack() {
    return read(MUSIC_KEY);
}

export function setMusicTrack(name) {
    write(MUSIC_KEY, name || null);
    return name || null;
}

/* ---------- render on save ---------- */

/**
 * Whether saving a chapter should quietly bring its audio up to date.
 *
 * Off by default, and that is deliberate. Rendering is local and cheap but it
 * is not free, and a writer who never listens to anything should not have
 * their machine synthesising every paragraph they touch. Turning it on is the
 * writer saying "I am working on the audio of this book".
 *
 * When it is on, only paragraphs whose text actually changed are rendered, so
 * the usual cost of a save is one paragraph.
 */
export function getRenderOnSave() {
    return read(ON_SAVE_KEY) === 'true';
}

export function setRenderOnSave(on) {
    write(ON_SAVE_KEY, on ? 'true' : null);
    return !!on;
}

/**
 * Falls back to the first installed voice when nothing is chosen, or when the
 * chosen one has since been removed. Returning a voice that is not on disk
 * would fail at render time with an error about a missing file, several clicks
 * away from the menu that could fix it.
 */
export function resolveVoice(installed) {
    const chosen = getVoice();
    if (chosen && installed.includes(chosen)) return chosen;
    return installed[0] || null;
}

/**
 * "en_US-lessac-medium" -> "Lessac". The catalogue carries a name field, but
 * the player needs to label a voice it may only know by id.
 */
export function displayName(id) {
    if (!id) return '';
    const parts = String(id).split('-');
    const name = parts[1] || id;
    return name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ');
}
