// views/dashboard/sections/dictionary/dictionary.js

/**
 * The dictionary page.
 *
 * One list, two questions: is this a word, and how is it said. They used to be
 * two stores with two keys, and because the keys disagreed a word added from
 * the Spelling panel went on being reported as unknown for ever. Merging them
 * is what makes "add to dictionary" mean anything.
 *
 * Editing is inline. This page exists to be worked through - a writer arrives
 * with a list of invented names and goes down it - and a dialog per word would
 * be four extra clicks each. Clicking a respelling turns it into a field;
 * Enter or blur saves it.
 *
 * Everything routes through the same save, so there is one place where a write
 * happens and one place that redraws.
 */

import { escapeHtml } from '../../components/Editor/EditorRender.js';

let story = null;
let layers = { global: {}, story: {} };
let filter = 'all';
let search = '';
let els = {};

export function initDictionary() {
    els = {
        word: document.getElementById('dictWord'),
        spoken: document.getElementById('dictSpoken'),
        scope: document.getElementById('dictScope'),
        addBtn: document.getElementById('dictAddBtn'),
        testBtn: document.getElementById('dictTestBtn'),
        phonemes: document.getElementById('dictPhonemes'),
        note: document.getElementById('dictNote'),
        search: document.getElementById('dictSearch'),
        rows: document.getElementById('dictRows'),
        count: document.getElementById('dictCount') || document.getElementById('dictionaryCount'),
        tabs: [...document.querySelectorAll('.dictionary__tab')]
    };
    if (!els.rows) return;

    els.addBtn.addEventListener('click', () => add());
    els.testBtn.addEventListener('click', () => audition());

    [els.word, els.spoken].forEach(field => {
        field.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            add();
        });
        field.addEventListener('input', debounce(showPhonemes, 400));
    });

    els.search.addEventListener('input', debounce(() => {
        search = els.search.value.trim().toLowerCase();
        draw();
    }, 150));

    els.tabs.forEach(tab => tab.addEventListener('click', () => {
        filter = tab.dataset.filter;
        els.tabs.forEach(t => t.classList.toggle('is-active', t === tab));
        draw();
    }));

    els.rows.addEventListener('click', onRowClick);

    // The story layer follows whatever the editor has open.
    document.addEventListener('manuscriptOpened', (event) => {
        const next = event.detail?.story || null;
        if (next === story) return;
        story = next;
        if (story && els.scope.value === 'global') els.scope.value = 'story';
        load();
    });

    // A word added from the Spelling panel belongs here too.
    document.addEventListener('dictionaryChanged', () => load());

    // Which story is open, without waiting to be told.
    //
    // manuscriptOpened fires when the editor opens a chapter, which has
    // already happened by the time anybody navigates here - this page arrives
    // long after the event and would otherwise sit there believing no story is
    // open, refusing to add a word to a book that is plainly on screen. The
    // editor writes the same place to localStorage for its own restore; this
    // reads it.
    story = lastStory();
    if (!story) els.scope.value = 'global';

    load();
}

const LAST_PLACE_KEY = 'prose_engine_last_place';

function lastStory() {
    try {
        return JSON.parse(localStorage.getItem(LAST_PLACE_KEY))?.story || null;
    } catch {
        return null;
    }
}

/* ---------- data ---------- */

async function load() {
    try {
        const url = story ? `/api/dictionary?story=${encodeURIComponent(story)}` : '/api/dictionary';
        const data = await (await fetch(url)).json();
        if (!data.ok) throw new Error(data.message);
        layers = { global: data.global || {}, story: data.story || {} };
        setNote('');
    } catch (err) {
        setNote(`Could not load the dictionary: ${err.message}`);
    }
    draw();
}

async function save(body, failure) {
    try {
        const res = await fetch('/api/dictionary', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ story, ...body })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.message);

        layers = { global: data.global || {}, story: data.story || {} };
        setNote('');
        draw();

        // A saved pronunciation makes rendered audio for that word stale.
        document.dispatchEvent(new CustomEvent('narratorLexiconChanged', { detail: { story } }));
        return true;
    } catch (err) {
        setNote(`${failure}: ${err.message}`);
        return false;
    }
}

async function post(path, body, failure) {
    try {
        const res = await fetch(`/api/dictionary/${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ story, ...body })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.message);
        layers = { global: data.global || {}, story: data.story || {} };
        setNote('');
        draw();
        document.dispatchEvent(new CustomEvent('narratorLexiconChanged', { detail: { story } }));
    } catch (err) {
        setNote(`${failure}: ${err.message}`);
    }
}

async function add() {
    const word = els.word.value.trim();
    if (!word) return;

    // Adding to the story list with no story open would have nowhere to go,
    // and the error from the server says so less clearly than this does.
    if (els.scope.value === 'story' && !story) {
        setNote('Open a story first, or add this to every story instead.');
        return;
    }

    const saved = await save({ scope: els.scope.value, word, spoken: els.spoken.value.trim() }, 'Could not add');
    if (!saved) return;

    els.word.value = '';
    els.spoken.value = '';
    els.phonemes.textContent = '';
    els.word.focus();
}

/* ---------- rows ---------- */

/** Both layers as one sorted list, each row remembering which list it is in. */
function rows() {
    const all = [
        ...Object.entries(layers.global).map(([word, e]) => ({ word, spoken: e.spoken || '', scope: 'global' })),
        ...Object.entries(layers.story).map(([word, e]) => ({ word, spoken: e.spoken || '', scope: 'story' }))
    ];

    return all
        .filter(r => filter === 'all'
            || (filter === 'spoken' ? !!r.spoken : r.scope === filter))
        .filter(r => !search || r.word.toLowerCase().includes(search))
        .sort((a, b) => a.word.localeCompare(b.word, undefined, { sensitivity: 'base' }));
}

function draw() {
    const list = rows();
    const total = Object.keys(layers.global).length + Object.keys(layers.story).length;
    if (els.count) els.count.textContent = `${total} word${total === 1 ? '' : 's'}`;

    if (!list.length) {
        els.rows.innerHTML = `<p class="dictionary__empty">${escapeHtml(
            total ? 'Nothing matches that.' : 'No words yet. Add one above, or use "add to dictionary" in the Spelling panel.'
        )}</p>`;
        return;
    }

    els.rows.innerHTML = list.map(r => `
        <div class="dictionary__row" role="row" data-word="${escapeHtml(r.word)}" data-scope="${r.scope}">
            <span class="dictionary__word" role="cell">${escapeHtml(r.word)}</span>
            <button type="button" class="dictionary__spoken" role="cell" data-edit
                title="Click to change how this is said">${r.spoken
            ? escapeHtml(r.spoken)
            : '<span class="dictionary__unset">say it normally</span>'}</button>
            <button type="button" class="dictionary__scope" role="cell" data-move
                title="${r.scope === 'story' ? 'Move to every story' : 'Move to this story only'}">
                ${r.scope === 'story' ? 'this story' : 'every story'}
            </button>
            <span class="dictionary__actions" role="cell">
                <button type="button" class="dictionary__icon" data-say title="Hear it" aria-label="Hear ${escapeHtml(r.word)}">
                    <ion-icon name="volume-medium"></ion-icon>
                </button>
                <button type="button" class="dictionary__icon dictionary__icon--danger" data-remove
                    title="Remove" aria-label="Remove ${escapeHtml(r.word)}">
                    <ion-icon name="close"></ion-icon>
                </button>
            </span>
        </div>`).join('');
}

function onRowClick(event) {
    const row = event.target.closest('.dictionary__row');
    if (!row) return;

    const { word, scope } = row.dataset;

    if (event.target.closest('[data-remove]')) return post('remove', { scope, word }, 'Could not remove');
    if (event.target.closest('[data-move]')) return post('move', { scope, word }, 'Could not move');
    if (event.target.closest('[data-say]')) return speak(currentSpoken(word, scope) || word);
    if (event.target.closest('[data-edit]')) return editSpoken(row, word, scope);
}

function currentSpoken(word, scope) {
    return (layers[scope]?.[word]?.spoken) || '';
}

/**
 * Turns the respelling cell into a field in place. Enter or leaving the field
 * saves; Escape abandons it. A word is a small edit and does not deserve a
 * dialog.
 */
function editSpoken(row, word, scope) {
    const cell = row.querySelector('.dictionary__spoken');
    if (cell.querySelector('input')) return;

    const value = currentSpoken(word, scope);
    cell.innerHTML = `<input class="glass-input dictionary__edit" value="${escapeHtml(value)}"
        placeholder="SY-liss" aria-label="How to say ${escapeHtml(word)}">`;
    const input = cell.querySelector('input');
    input.focus();
    input.select();

    let done = false;
    const commit = () => {
        if (done) return;
        done = true;
        const next = input.value.trim();
        if (next === value) { draw(); return; }
        save({ scope, word, spoken: next }, 'Could not save');
    };

    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); commit(); }
        if (event.key === 'Escape') { done = true; draw(); }
    });
    input.addEventListener('blur', commit);
}

/* ---------- hearing it ---------- */

function voice() {
    try {
        return localStorage.getItem('narrator_voice');
    } catch {
        return null;
    }
}

function speak(text) {
    const id = voice();
    if (!id) {
        setNote('Choose a voice in the Narrator menu first.');
        return;
    }
    new Audio(`/api/narrator/say?voice=${encodeURIComponent(id)}&text=${encodeURIComponent(text)}`)
        .play().catch(err => setNote(`Could not play that: ${err.message}`));
}

/** Auditions the REPLACEMENT, since that is the string being tested. */
function audition() {
    const say = els.spoken.value.trim() || els.word.value.trim();
    if (say) speak(say);
}

/**
 * The phonemes the voice will really use, as it is typed.
 *
 * This is the check a respelling could never offer. "SY-liss" comes out as
 * ess-why-liss because espeak reads the letters, and the only previous way to
 * discover that was to listen and be puzzled.
 */
async function showPhonemes() {
    const say = els.spoken.value.trim() || els.word.value.trim();
    const id = voice();
    if (!say || !id) {
        els.phonemes.textContent = '';
        return;
    }

    try {
        const res = await fetch(`/api/dictionary/phonemes?voice=${encodeURIComponent(id)}` +
            `&text=${encodeURIComponent(say)}`);
        const data = await res.json();
        // The engine appends a full stop to give a passage an ending; on one
        // word that is an artefact of the pipeline, not how the word is said.
        els.phonemes.textContent = data.ok ? data.phonemes.replace(/[,.;:!?]\s*$/, '') : '';
    } catch {
        els.phonemes.textContent = '';
    }
}

/* ---------- shared ---------- */

function setNote(message) {
    if (!els.note) return;
    els.note.textContent = message || '';
    els.note.classList.toggle('hidden', !message);
}

function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}
