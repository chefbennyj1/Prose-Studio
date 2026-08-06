// views/dashboard/components/Narrator/NarratorMenu.js

/**
 * The Narrator menu in the studio rail.
 *
 * Which voice narrates, and whether saving should keep the audio current.
 * Both came out of the editor's side panel, where they were settings sitting
 * in the middle of a writing surface; the panel's job is to show what the
 * critic found.
 *
 * VOICES. Piper voices are downloaded, not bundled: 20-120MB each, and nobody
 * needs 171 of them. The flyout lists what is installed first, then what can
 * be fetched, and choosing an uninstalled voice downloads it. Only English
 * voices are offered - the spelling dictionary and the critic are English-only
 * too, so a Ukrainian narrator would be the odd one out rather than a feature.
 *
 * PRONUNCIATION USED TO BE HERE and is now the Dictionary page. It turned out
 * to be the same list as the spelling dictionary - an invented name is exactly
 * the word a checker does not know AND the word a narrator says wrongly - and
 * keeping two lists meant two keys, which meant a word added to one was
 * invisible to the other. One page owns words now.
 */

import { escapeHtml } from '../Editor/EditorRender.js';
import { setMusic } from './Player.js';
import {
    getVoice, setVoice, resolveVoice, displayName,
    getRenderOnSave, setRenderOnSave,
    getSpeed, setSpeed,
    getMusicTrack, setMusicTrack
} from './voices.js';

let voices = null;      // { installed: [], voices: [], catalogueError }
let installing = new Set();
let els = {};

export function initNarratorMenu() {
    els = {
        voiceValue: document.getElementById('narratorVoiceValue'),
        voiceFlyout: document.getElementById('narratorVoiceFlyout'),
        onSave: document.getElementById('narratorOnSaveBtn'),
        paceValue: document.getElementById('narratorPaceValue'),
        slower: document.getElementById('narratorSlowerBtn'),
        faster: document.getElementById('narratorFasterBtn'),
        paceTest: document.getElementById('narratorPaceTestBtn'),
        musicValue: document.getElementById('narratorMusicValue'),
        musicFlyout: document.getElementById('narratorMusicFlyout')
    };
    if (!els.voiceFlyout) return;

    drawVoiceValue();
    drawOnSave();
    drawPace();
    drawMusicValue();
    loadVoices();

    // The chosen track has to reach the player before the first press of
    // Listen, which can happen before this flyout is ever opened.
    setMusic(getMusicTrack());

    els.musicFlyout?.addEventListener('click', onMusicClick);
    document.querySelector('[data-narrator="music"]')
        ?.addEventListener('flyoutOpened', () => drawMusicList());

    // Changing the pace changes every segment hash, so the audio on disk is
    // stale the moment this moves. Nothing is rendered here - the editor is
    // told, and it reports what a render would cost.
    const nudge = (by) => (event) => {
        event.stopPropagation();      // a setting, not a command: menu stays open
        setSpeed(Number((getSpeed() + by).toFixed(2)));
        drawPace();
        document.dispatchEvent(new CustomEvent('narratorPaceChanged', {
            detail: { lengthScale: getSpeed() }
        }));
    };
    els.slower?.addEventListener('click', nudge(0.05));   // slower = larger scale
    els.faster?.addEventListener('click', nudge(-0.05));
    els.paceTest?.addEventListener('click', (event) => {
        event.stopPropagation();
        auditionPace();
    });

    els.onSave?.addEventListener('click', (event) => {
        event.stopPropagation();       // a setting, not a command: menu stays open
        setRenderOnSave(!getRenderOnSave());
        drawOnSave();
        document.dispatchEvent(new CustomEvent('narratorRenderOnSaveChanged', {
            detail: { enabled: getRenderOnSave() }
        }));
    });

    els.voiceFlyout.addEventListener('click', onVoiceClick);

    document.querySelector('[data-narrator="voice"]')
        ?.addEventListener('flyoutOpened', () => drawVoiceList());

    // Downloads report over the socket; the flyout may be open while one runs.
    if (window.socket) {
        window.socket.on('narrator:voice-progress', ({ id, percent }) => {
            const row = els.voiceFlyout.querySelector(`[data-id="${CSS.escape(id)}"] .rail-menu__count`);
            if (row) row.textContent = `${percent}%`;
        });
        window.socket.on('narrator:voice-installed', async ({ id }) => {
            installing.delete(id);
            voices = null;
            await loadVoices();
            if (!getVoice()) setVoice(id);
            drawVoiceValue();
            drawVoiceList(false);
            document.dispatchEvent(new CustomEvent('narratorVoiceChanged', { detail: { voice: getVoice() } }));
        });
        window.socket.on('narrator:voice-failed', ({ id, message }) => {
            installing.delete(id);
            const row = els.voiceFlyout.querySelector(`[data-id="${CSS.escape(id)}"] .rail-menu__count`);
            if (row) row.textContent = 'failed';
            console.error('[NarratorMenu] Voice download failed:', message);
        });
    }
}

/**
 * Words a minute, not length_scale.
 *
 * The scale is what Piper takes and it is backwards - larger is slower - so
 * showing it would need explaining every time. Measured on lessac-medium,
 * scale 1 reads at ~222 wpm, and the relationship is close enough to inverse
 * over this range to label the control honestly.
 */
const WPM_AT_SCALE_1 = 222;

function drawPace() {
    if (!els.paceValue) return;
    const scale = getSpeed();
    els.paceValue.textContent = `${Math.round(WPM_AT_SCALE_1 / scale)} wpm`;

    // Nothing to press at the ends of the range.
    if (els.slower) els.slower.disabled = scale >= 2;
    if (els.faster) els.faster.disabled = scale <= 1;
}

/**
 * A line of ordinary narration, spoken at whatever the pace is now.
 *
 * Two sentences rather than one, because the gap between them is part of what
 * a pace change alters and a single clause does not reveal it. Deliberately
 * plain prose - a sample full of proper nouns would test the dictionary
 * instead of the speed.
 */
const PACE_SAMPLE = 'She put the letter down and looked out at the rain. ' +
    'It had been falling since the morning, and it showed no sign of stopping.';

let paceAudio = null;

function auditionPace() {
    const voice = getVoice();
    if (!voice) return;

    // Pressing it again while it is speaking replaces the sample rather than
    // layering a second copy over the first.
    if (paceAudio) { paceAudio.pause(); paceAudio = null; }

    paceAudio = new Audio(`/api/narrator/say?voice=${encodeURIComponent(voice)}` +
        `&lengthScale=${getSpeed()}&text=${encodeURIComponent(PACE_SAMPLE)}`);
    paceAudio.play().catch(() => { paceAudio = null; });
}

function drawOnSave() {
    if (!els.onSave) return;
    const on = getRenderOnSave();
    els.onSave.setAttribute('aria-checked', on ? 'true' : 'false');
    els.onSave.classList.toggle('is-on', on);
}

/* ---------- music ---------- */

let tracks = null;

function drawMusicValue() {
    if (!els.musicValue) return;
    const name = getMusicTrack();
    els.musicValue.textContent = name ? name.replace(/\.[^.]+$/, '') : 'none';
}

/**
 * @param {boolean} refetch  read the folder again rather than redrawing what
 *                           was last seen.
 *
 * Opening the menu always refetches. The list is a directory listing, and the
 * whole way tracks get added is dropping files into that folder while the app
 * is running - a cached list means the writer copies in a track, opens the
 * menu, and does not find it. Redraws after picking pass false, because
 * nothing on disk changed and a round trip would just make the tick lag.
 */
async function drawMusicList(refetch = true) {
    if (refetch || !tracks) {
        if (!tracks) els.musicFlyout.innerHTML = note('Looking for tracks...');
        try {
            tracks = await (await fetch('/api/narrator/music')).json();
        } catch {
            els.musicFlyout.innerHTML = note('Could not reach the server.');
            return;
        }
    }

    const chosen = getMusicTrack();
    const rows = [option('', 'None', 'no music', !chosen)];

    for (const name of tracks.tracks || []) {
        rows.push(option(name, name.replace(/\.[^.]+$/, ''), '', name === chosen));
    }

    // With nothing to choose from, the folder IS the instruction.
    if (!(tracks.tracks || []).length) {
        rows.push(note(`Drop audio files into ${tracks.folder} and they will appear here.`));
    }

    els.musicFlyout.innerHTML = rows.join('');
}

function onMusicClick(event) {
    const item = event.target.closest('.rail-menu__entry');
    if (!item) return;

    const name = item.dataset.id || null;
    setMusicTrack(name);
    setMusic(name);          // takes effect immediately, even mid-sentence
    drawMusicValue();
    drawMusicList(false);
}

/* ---------- voices ---------- */

async function loadVoices() {
    try {
        voices = await (await fetch('/api/narrator/voices')).json();
    } catch {
        voices = { ok: false, installed: [], voices: [], catalogueError: 'Could not reach the server.' };
    }

    // Settle on a voice that actually exists, so the first render does not
    // fail on a name left over from a removed one.
    const resolved = resolveVoice(voices.installed || []);
    if (resolved !== getVoice()) setVoice(resolved);

    drawVoiceValue();
    document.dispatchEvent(new CustomEvent('narratorVoiceChanged', { detail: { voice: resolved } }));
    return voices;
}

function drawVoiceValue() {
    if (!els.voiceValue) return;
    const id = getVoice();
    els.voiceValue.textContent = id ? displayName(id) : 'none yet';
}

/**
 * @param {boolean} refetch  ask the server again rather than redrawing.
 *
 * Opening the menu always refetches, for the same reason the music list does:
 * which voices are installed is a directory on disk, and a download that
 * finished a moment ago must show as installed. The server caches the Hugging
 * Face catalogue for an hour, so this is cheap.
 */
async function drawVoiceList(refetch = true) {
    if (refetch || !voices) {
        if (!voices) els.voiceFlyout.innerHTML = note('Loading voices...');
        await loadVoices();
    }

    const installed = voices.installed || [];
    const chosen = getVoice();
    const english = (voices.voices || []).filter(v => v.language?.startsWith('en'));

    const rows = [];

    if (installed.length) {
        rows.push(heading('On this machine'));
        rows.push(...installed.map(id => {
            const meta = english.find(v => v.id === id);
            return option(id, displayName(id), meta ? `${meta.language} ${meta.quality}` : 'installed', id === chosen);
        }));
    }

    const available = english.filter(v => !installed.includes(v.id));
    if (available.length) {
        rows.push(heading(installed.length ? 'Download another' : 'Download a voice'));
        rows.push(...available.map(v => option(
            v.id,
            displayName(v.id),
            `${v.quality} · ${megabytes(v.bytes)}`,
            false,
            true
        )));
    }

    if (!rows.length) {
        els.voiceFlyout.innerHTML = note(voices.catalogueError
            ? `No voices installed, and the list could not be fetched. ${voices.catalogueError}`
            : 'No voices are available.');
        return;
    }

    if (voices.catalogueError && installed.length) {
        rows.push(note(`More voices could not be listed. ${voices.catalogueError}`));
    }

    els.voiceFlyout.innerHTML = rows.join('');
}

async function onVoiceClick(event) {
    const item = event.target.closest('.rail-menu__entry');
    if (!item) return;

    const id = item.dataset.id;

    if (item.dataset.install === 'true') {
        if (installing.has(id)) return;
        installing.add(id);
        item.querySelector('.rail-menu__count').textContent = 'starting...';
        try {
            await fetch('/api/narrator/voices/install', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            });
        } catch {
            installing.delete(id);
            item.querySelector('.rail-menu__count').textContent = 'failed';
        }
        return;
    }

    setVoice(id);
    drawVoiceValue();
    drawVoiceList(false);
    document.dispatchEvent(new CustomEvent('narratorVoiceChanged', { detail: { voice: id } }));
}

function megabytes(bytes) {
    if (!bytes) return 'download';
    return `${Math.round(bytes / (1024 * 1024))}MB`;
}

/* ---------- shared ---------- */

function option(id, name, caption, active, install = false) {
    return `<button type="button" class="rail-menu__item rail-menu__entry${active ? ' is-active' : ''}"
                role="menuitemradio" aria-checked="${active ? 'true' : 'false'}"
                data-id="${escapeHtml(id)}" data-install="${install}">
                <span class="rail-menu__name">${escapeHtml(name)}</span>
                <span class="rail-menu__count">${escapeHtml(caption)}</span>
            </button>`;
}

function heading(text) {
    return `<p class="rail-menu__heading">${escapeHtml(text)}</p>`;
}

function note(message) {
    return `<p class="rail-menu__note">${escapeHtml(message)}</p>`;
}

function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}
