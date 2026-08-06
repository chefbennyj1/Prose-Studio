// views/dashboard/components/Editor/Editor.js

/**
 * The writing surface.
 *
 * Deliberately a plain <textarea> rather than a rich-text rig. The whole point
 * of the Prose Engine is that the manuscript is text; a contenteditable would
 * add a DOM-to-Markdown round trip, break the browser's own spellchecker in
 * subtle ways, and buy nothing a novel needs.
 *
 * A chapter is one file. Pages are NOT stored — they are worked out from the
 * word count and drawn as rules across the page, because a writer cannot know
 * where page 4 ends and should not have to. See PAGE_WORDS.
 *
 * The three buttons map onto the three tiers that do the checking, in order of
 * how much they cost:
 *   - the browser spellchecks live, for free, as you type
 *   - "Spelling" runs the server dictionary, which reports what the browser
 *     cannot: a readable list, grouped and counted, seeded with character names
 *   - "Scan page" and "Critique" wake the local model, which is why they are
 *     on-demand buttons and not something that fires on every keystroke
 */

import { escapeHtml, renderMarkdown } from './EditorRender.js';
import {
    init as initPlayer,
    load as playerLoad,
    toggle as playerToggle,
    stop as stopPlayer,
    skip as playerSkip,
    summary as playerSummary,
    isLoaded as playerLoaded,
    isPlaying
} from '../Narrator/Player.js';
import { createSurface } from './Surface.js';

const AUTOSAVE_MS = 4000;

/**
 * Standard manuscript format: 250 words to the page — 12pt Courier,
 * double-spaced, one-inch margins. The number publishers estimate length with.
 * Must stay in step with PAGE_WORDS in ManuscriptService.
 */
const PAGE_WORDS = 250;

// Where the writer was last time. Reopening on the blank first story every
// session is the kind of small friction that stops people writing.
const LAST_PLACE_KEY = 'prose_engine_last_place';

let els = {};

// The writing surface. Everything that reads or writes the manuscript text
// goes through this, never through the DOM - see Surface.js.
let surface = null;

let doc = { story: null, chapter: null, modified: 0 };
let dirty = false;
let autosaveTimer = null;

// Is there anywhere on disk to save to at all? Set when the story list loads.
let storyRootReady = false;

// There is no "became non-empty" event on a textarea — `input` fires on every
// change and you spot the transition yourself. Worth doing: it lets the editor
// warn on the FIRST keystroke that this text has nowhere to go, instead of at
// the save that comes an hour later.
let hadText = false;

export async function initEditor(container) {
    els = {
        where: document.getElementById('editorWhere'),
        host: document.getElementById('editorSurface'),
        words: document.getElementById('editorWordCount'),
        pages: document.getElementById('editorPageCount'),
        state: document.getElementById('editorSaveState'),
        saveBtn: document.getElementById('editorSaveBtn'),
        lens: document.getElementById('editorLensSelect'),
        engine: document.getElementById('editorEngineSelect'),
        spellBtn: document.getElementById('editorSpellBtn'),
        scanBtn: document.getElementById('editorScanBtn'),
        critiqueBtn: document.getElementById('editorCritiqueBtn'),
        output: document.getElementById('editorOutput'),
        playBtn: document.getElementById('narratorPlayBtn'),
        playIcon: document.getElementById('narratorPlayIcon'),
        playLabel: document.getElementById('narratorPlayLabel'),
        prevBtn: document.getElementById('narratorPrevBtn'),
        nextBtn: document.getElementById('narratorNextBtn'),
        renderBtn: document.getElementById('narratorRenderBtn'),
        rerenderBtn: document.getElementById('narratorRerenderBtn'),
        progress: document.getElementById('narratorProgress'),
        progressBar: document.getElementById('narratorProgressBar'),
        narratorStatus: document.getElementById('narratorStatus')
    };
    if (!els.host) return;

    // Built before anything can load a chapter into it.
    surface = createSurface(els.host, {
        onSave: () => save(),
        onChange: () => {
            updateCounts();
            markDirty();

            const hasText = surface.length > 0;
            if (hasText && !hadText) warnIfNowhereToSave();
            hadText = hasText;
        }
    });

    await Promise.all([openLastPlace(), loadCriticOptions()]);

    els.saveBtn.addEventListener('click', () => save());

    // Chosen from the Story or Chapter menu in the studio rail. A story with
    // no chapter named means "open this story at its first chapter", which is
    // what picking a story from the list should do.
    document.addEventListener('openManuscript', (event) => {
        const { story, chapter } = event.detail || {};
        if (!story) return;
        if (story !== doc.story) {
            selectStory(story, { chapter });
            return;
        }
        if (chapter) openChapter(chapter);
    });

    // Changing the story folder in Settings invalidates everything on screen.
    document.addEventListener('storyRootChanged', () => {
        doc = { story: null, chapter: null, modified: 0 };
        dirty = false;
        surface.setValue('');
        openLastPlace();
    });

    // A story or chapter made in the rail should appear here without a reload.
    document.addEventListener('storyTreeChanged', (e) => {
        openLastPlace({ story: e.detail?.story, chapter: e.detail?.chapter });
    });

    els.spellBtn.addEventListener('click', runSpelling);
    els.scanBtn.addEventListener('click', runScan);
    els.critiqueBtn.addEventListener('click', runCritique);

    setUpNarrator();

    // Numbers logical lines, to agree with the "line 47" the spelling panel
    // reports. Keeps its own debounced input listener; the explicit refreshes
    // below are for the times the text changes without an input event.
    // Line numbers are the surface's own; see Surface.js.

    // Ctrl/Cmd+S is bound inside the surface; CodeMirror owns its own keymap.

    // Suggestions arrive on the socket, minutes after the scan was requested.
    if (window.socket) {
        window.socket.on('proofing_suggestions', (payload) => renderSuggestions(payload));
        window.socket.on('manuscript:changed', (payload) => onDiskChange(payload));
    }

    window.addEventListener('beforeunload', (e) => {
        if (!dirty) return;
        e.preventDefault();
        e.returnValue = '';
    });

    updateCounts();
}

/* ---------- story / chapter ---------- */

/**
 * Says what is open, in the bar where the pickers used to be. Also tells the
 * rail menus, so the list can tick the entry you are actually in.
 */
function showWhere() {
    if (els.where) {
        els.where.innerHTML = doc.chapter
            ? `${escapeHtml(doc.story)} <strong>${escapeHtml(doc.chapter)}</strong>`
            : (doc.story ? escapeHtml(doc.story) : 'nothing open');
    }

    document.dispatchEvent(new CustomEvent('manuscriptOpened', {
        detail: { story: doc.story, chapter: doc.chapter }
    }));
}

/**
 * Every list call can come back with NO_STORY_ROOT. Handled in one place so the
 * writer gets the same "go to Settings" message wherever they hit it, rather
 * than a filesystem error they cannot act on.
 */
async function apiGet(url) {
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) {
        const err = new Error(data.message);
        err.code = data.code;
        throw err;
    }
    return data;
}

/**
 * Nothing on this path may take the writer away from their text.
 *
 * The editor stays fully usable with no story folder set — you can write a
 * whole chapter before the engine has anywhere to put it. Settings opens in a
 * NEW TAB, because navigating this one away would discard the buffer, and
 * losing a night's work to a configuration prompt is the worst thing this
 * application could do to someone.
 */
function promptForSettings(headline) {
    els.output.innerHTML =
        `<div class="editor__conflict"><strong>${escapeHtml(headline)}</strong> ` +
        'Choose the parent folder your writing should be saved into. ' +
        'Your text stays here — Settings opens in a new tab.' +
        '<div class="editor__conflict-actions">' +
        '<button type="button" id="editorOpenSettings" class="glass glass-btn glass-btn--primary glass-btn--sm">' +
        'Open Settings in a new tab</button></div></div>';

    document.getElementById('editorOpenSettings')?.addEventListener('click', () => {
        window.open('/dashboard?tab=library-settings', '_blank', 'noopener');
    });
}

/** The panel's resting state, restored once a warning stops being true. */
function resetOutputHint() {
    els.output.innerHTML =
        '<p class="text-muted italic">Spelling is instant. A page scan and a critique both ' +
        'run the local model, so give them a minute.</p>';
}

function reportNoRoot() {
    storyRootReady = false;
    setState('no story folder');
    promptForSettings('No story folder is set.');
}

/**
 * Fires on the keystroke that turns an empty surface into a non-empty one.
 * Telling someone at word 1 that this has nowhere to land is worth a little
 * noise; telling them at word 2,000 is not a warning, it is an apology.
 */
function warnIfNowhereToSave() {
    if (!storyRootReady) {
        promptForSettings('This has nowhere to be saved yet.');
        return;
    }
    if (!doc.chapter) {
        els.output.innerHTML =
            '<div class="editor__conflict"><strong>No chapter open.</strong> ' +
            'Create a story and a chapter from the rail on the left — your text stays here until you do.</div>';
    }
}

function rememberPlace() {
    try {
        localStorage.setItem(LAST_PLACE_KEY, JSON.stringify({ story: doc.story, chapter: doc.chapter }));
    } catch { /* private browsing; the editor still works */ }
}

function lastPlace() {
    try {
        return JSON.parse(localStorage.getItem(LAST_PLACE_KEY)) || {};
    } catch {
        return {};
    }
}

/**
 * Opens where the writer left off, falling back to the first of everything.
 * Pass a target to open somewhere specific — used after the rail creates one.
 */
async function openLastPlace(want) {
    const target = { ...lastPlace(), ...Object.fromEntries(Object.entries(want || {}).filter(([, v]) => v)) };

    let stories;
    try {
        stories = (await apiGet('/api/manuscript/stories')).stories;
    } catch (err) {
        if (err.code === 'NO_STORY_ROOT') return reportNoRoot();
        setState('error: ' + err.message);
        return;
    }

    storyRootReady = true;

    if (!stories.length) {
        setState('create a story from the rail to begin');
        showWhere();
        return;
    }

    const story = stories.some(s => s.name === target.story) ? target.story : stories[0].name;
    await selectStory(story, target);
}

/**
 * Opens a story at its first chapter, or at `want.chapter` if that one exists.
 *
 * `doc` is NOT touched until something has actually been loaded, and that is
 * load-bearing rather than tidiness. This used to assign doc.story on its first
 * line and then return early when the buffer was dirty, which left doc naming
 * a chapter of the NEW story while the surface still held the OLD story's
 * text. The four-second autosave would then fire and POST one story's words
 * into another story's chapter. It was only ever caught by the staleness check
 * rejecting the mismatched mtime — with the right timing it would have
 * overwritten a chapter of a different book.
 */
async function selectStory(story, want = {}) {
    let chapters;
    try {
        chapters = (await apiGet(`/api/manuscript/chapters?story=${encodeURIComponent(story)}`)).chapters;
    } catch (err) {
        setState('error: ' + err.message);
        return;
    }

    if (!chapters.length) {
        if (dirty && !confirm('You have unsaved changes. Discard them and open another story?')) return;

        clearTimeout(autosaveTimer);
        stopPlayer();
        doc = { story, chapter: null, modified: 0 };
        dirty = false;
        surface.setValue('');
        updateCounts();
        setState('create a chapter from the rail to begin');
        showWhere();
        rememberPlace();
        return;
    }

    const chapter = chapters.some(c => c.name === want.chapter) ? want.chapter : chapters[0].name;
    await openChapter(chapter, story);
}

/**
 * @param {string} [fromStory]  open a chapter of a DIFFERENT story; defaults
 *                              to the one already open.
 *
 * doc is only reassigned once the read has succeeded, so a failed open leaves
 * the editor describing the file it still actually holds.
 */
async function openChapter(chapter, fromStory) {
    if (!chapter) return;
    const story = fromStory || doc.story;
    if (!story) return;

    // Nothing to put back on refusal now that the picker is gone: the menu
    // closed itself and doc still names the chapter that is actually open.
    if (dirty && !confirm('You have unsaved changes. Discard them and open another chapter?')) return;

    // A queued autosave belongs to the document being left, and it must not
    // land after doc has moved on.
    clearTimeout(autosaveTimer);

    // The narrator is speaking text that is about to leave the screen.
    stopPlayer();

    try {
        const data = await apiGet(
            `/api/manuscript/read?story=${encodeURIComponent(story)}&chapter=${encodeURIComponent(chapter)}`
        );

        doc = { story: data.story, chapter: data.name, modified: data.modified };
        // A different file: the undo history goes with the old one.
        surface.setValue(data.text);
        showWhere();
        setState('saved');
        dirty = false;
        hadText = data.text.length > 0;
        updateCounts();
        rememberPlace();

        // A chapter is open, so any "nowhere to save this" notice is now a lie.
        if (els.output.querySelector('.editor__conflict')) resetOutputHint();

        // Whatever audio exists for the chapter just opened.
        refreshAudio();
    } catch (err) {
        setState('error: ' + err.message);
    }
}

/* ---------- the file changed underneath us ---------- */

/**
 * A chapter changed on disk. Three cases, and the ordering matters:
 *
 *   1. It was our own save echoing back — the mtime matches what we hold.
 *      Silence. Every save fires this event; reacting would flicker constantly.
 *   2. It is a different chapter — refresh the picker's counts, nothing more.
 *   3. It is THIS chapter, changed by something else. If the buffer is clean,
 *      swap the text in. If it is dirty, say so and touch nothing: the writer's
 *      unsaved words outrank the file every single time.
 */
async function onDiskChange(payload) {
    if (!payload || payload.story !== doc.story) return;

    // Another chapter in the same story. The rail menus read their lists when
    // they open, so there is nothing here to keep in step.
    if (payload.chapter !== doc.chapter) return;

    // Our own write, arriving back. Nothing to do.
    if (payload.modified && Math.abs(payload.modified - doc.modified) <= 1) return;

    if (payload.deleted) {
        setState('deleted on disk');
        els.output.innerHTML =
            '<div class="editor__conflict"><strong>This chapter was deleted on disk.</strong> ' +
            'Your text is still here. Save it to write the file back.</div>';
        doc.modified = 0;
        dirty = true;
        return;
    }

    if (dirty) {
        setState('changed on disk');
        els.output.innerHTML =
            '<div class="editor__conflict"><strong>This chapter changed on disk</strong> while you have ' +
            'unsaved changes. Nothing here has been touched. Saving now will be refused rather than ' +
            'overwrite the newer file — copy what you need, then reload the chapter.' +
            '<div class="editor__conflict-actions">' +
            '<button type="button" id="editorReloadChapter" class="glass glass-btn glass-btn--sm">' +
            'Discard mine and reload</button></div></div>';
        document.getElementById('editorReloadChapter')?.addEventListener('click', () => {
            dirty = false;              // the writer just chose the file
            openChapter(doc.chapter);
        });
        return;
    }

    // Clean buffer: take the new text. Keep the caret where it was, so an
    // external tidy-up does not throw the writer back to the top of the file.
    const caret = surface.getSelection().from;
    await openChapter(doc.chapter);
    surface.setSelection(Math.min(caret, surface.length));
}

/* ---------- saving ---------- */

function markDirty() {
    dirty = true;
    setState('unsaved');
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => save(true), AUTOSAVE_MS);
}

async function save(isAuto = false) {
    // Pressed Save with nowhere to put it. Say so and offer Settings in a new
    // tab; never navigate this one, the buffer is the only copy of their work.
    if (!storyRootReady) {
        setState('no story folder');
        promptForSettings('There is nowhere to save this yet.');
        return;
    }
    if (!doc.story || !doc.chapter) {
        setState('no chapter open');
        els.output.innerHTML =
            '<div class="editor__conflict"><strong>No chapter open.</strong> ' +
            'Create a story and a chapter from the rail on the left, then press Save again. ' +
            'Your text stays here.</div>';
        return;
    }
    if (!dirty) return;

    clearTimeout(autosaveTimer);
    setState(isAuto ? 'autosaving...' : 'saving...');

    try {
        const res = await fetch('/api/manuscript/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                story: doc.story,
                chapter: doc.chapter,
                text: surface.getValue(),
                baseModified: doc.modified
            })
        });
        const data = await res.json();

        // 409: the file moved under us. Never silently overwrite the newer copy.
        if (res.status === 409) {
            setState(data.code === 'NO_STORY_ROOT' ? 'no story folder' : 'conflict');
            els.output.innerHTML =
                `<div class="editor__conflict"><strong>Not saved.</strong> ${escapeHtml(data.message)}</div>`;
            return;
        }
        if (!data.ok) throw new Error(data.message);

        doc.modified = data.modified;
        dirty = false;
        setState('saved');
        updateCounts();
        rememberPlace();

        // The words on disk changed, so the audio for some paragraph is now
        // out of date. Brings it back in line if the writer asked for that.
        scheduleRenderAfterSave();
    } catch (err) {
        setState('error: ' + err.message);
    }
}

function setState(text) {
    if (els.state) els.state.textContent = text;
}

/**
 * Word count, page count, and the page rules behind the text.
 *
 * The rules are a repeating gradient rather than measured elements: the
 * surface has a fixed line-height, so a page is exactly linesPerPage lines
 * tall and the browser can repeat that for free. It scrolls with the text
 * because it is the textarea's own background.
 *
 * Honest about what it is: this counts EDITOR lines at this measure, which is
 * a working estimate of a 250-word manuscript page, not a typesetting proof.
 */
function updateCounts() {
    const trimmed = surface.getValue().trim();
    const words = trimmed ? trimmed.split(/\s+/).length : 0;
    const pages = Math.max(1, Math.ceil(words / PAGE_WORDS));

    els.words.textContent = `${words.toLocaleString()} word${words === 1 ? '' : 's'}`;
    if (els.pages) els.pages.textContent = `${pages.toLocaleString()} page${pages === 1 ? '' : 's'}`;

    drawPageRules();
}

let pageRuleHeight = 0;

function drawPageRules() {
    if (!surface) return;

    // .cm-content is the element that holds the text and is as tall as the
    // document, which is what the repeating gradient needs to sit on. The old
    // surface was the textarea itself; this is its counterpart.
    const content = surface.view.contentDOM;
    const style = getComputedStyle(content);
    const lineHeight = parseFloat(style.lineHeight);
    if (!lineHeight || Number.isNaN(lineHeight)) return;

    // How many words fit on a rendered line here, from the actual measure:
    // usable width / average glyph width, divided by average word length.
    const usable = content.clientWidth
        - parseFloat(style.paddingLeft || 0)
        - parseFloat(style.paddingRight || 0);
    if (usable <= 0) return;

    const avgCharPx = parseFloat(style.fontSize) * 0.5;   // ~0.5em for a serif
    const charsPerLine = Math.max(20, Math.floor(usable / avgCharPx));
    const wordsPerLine = Math.max(1, charsPerLine / 5.7); // 5.7 chars incl. space

    const height = Math.round((PAGE_WORDS / wordsPerLine) * lineHeight);
    if (height === pageRuleHeight) return;
    pageRuleHeight = height;

    content.style.setProperty('--page-height', `${height}px`);
    content.style.setProperty('--page-top', style.paddingTop);
}

/* ---------- narrator ---------- */

/**
 * Listening back to a chapter that has been rendered to audio.
 *
 * This used to synthesise during playback, in a Web Worker, racing the ear.
 * Piper renders faster than it plays and the result is kept, so playback is
 * now just a playlist and all of that machinery is gone — see Player.js.
 *
 * Render is a button and not a side effect of typing. Synthesis is cheap but
 * it is not free, and a writer mid-sentence does not want their machine
 * narrating the paragraph they are still changing. Pressing it re-renders only
 * the paragraphs whose text has actually changed.
 */
function setUpNarrator() {
    if (!els.playBtn) return;

    initPlayer({
        onState: (state) => {
            const speaking = state === 'playing';
            // Icon and label are separate elements; setting textContent on the
            // button would delete the <ion-icon> with it.
            if (els.playLabel) els.playLabel.textContent = speaking ? 'Pause' : 'Listen';
            els.playIcon?.setAttribute('name', speaking ? 'pause' : 'play');
            els.playBtn.classList.toggle('glass-btn--speaking', speaking);
            if (state === 'idle') showAudioState();
        },
        onSegment: ({ position, total, text }) =>
            setNarratorStatus(`Paragraph ${position} of ${total}`, text),
        onError: (message) => setNarratorStatus(`Playback stopped: ${message}`),
        onFinished: () => setNarratorStatus('Finished.')
    });

    els.playBtn.addEventListener('click', () => {
        if (!playerLoaded()) return;
        playerToggle();
    });

    els.prevBtn.addEventListener('click', () => playerSkip(-1));
    els.nextBtn.addEventListener('click', () => playerSkip(1));
    els.renderBtn.addEventListener('click', () => renderChapter());
    els.rerenderBtn.addEventListener('click', () => renderChapter({ force: true }));

    // Choosing a different voice invalidates every rendered paragraph, and
    // saving a pronunciation invalidates the ones containing that word. Both
    // are handled the same way: say so, and let the writer decide when to
    // spend the time.
    document.addEventListener('narratorVoiceChanged', () => refreshAudio());
    document.addEventListener('narratorLexiconChanged', () => refreshAudio());
    document.addEventListener('narratorPaceChanged', () => refreshAudio());

    if (window.socket) {
        window.socket.on('narrator:render-progress', ({ story, chapter, done, total }) => {
            if (story !== doc.story || chapter !== doc.chapter) return;
            setNarratorStatus(`Rendering ${done} of ${total}`, null, true);
            setProgress(done / total);
        });
    }
}

/**
 * What is on disk for the chapter now open, and therefore which buttons mean
 * anything. Called on every chapter change and after anything that could have
 * invalidated a render.
 */
async function refreshAudio() {
    stopPlayer();
    setProgress(null);

    if (!doc.story || !doc.chapter) {
        setNarratorStatus('');
        setTransport(false);
        return;
    }

    await playerLoad(doc.story, doc.chapter);
    showAudioState();
}

async function showAudioState() {
    const info = playerSummary();
    setTransport(!!info);

    if (!info) {
        setNarratorStatus('Not rendered yet.');
        return;
    }

    // How much of what is on disk still matches the text on screen. A chapter
    // rendered and then edited is the normal case, not an error, so it reports
    // the gap rather than refusing to play the part that is still good.
    const plan = await audioPlan();
    const stale = plan ? plan.pending : 0;

    setNarratorStatus(stale
        ? `${minutes(info.seconds)}, ${stale} paragraph${stale === 1 ? '' : 's'} changed since. Render to update.`
        : `${minutes(info.seconds)} in ${info.paragraphs} paragraphs.`);
}

async function audioPlan() {
    const voice = currentVoice();
    if (!voice || !doc.story || !doc.chapter) return null;

    try {
        const res = await fetch('/api/narrator/audio/plan' +
            `?story=${encodeURIComponent(doc.story)}&chapter=${encodeURIComponent(doc.chapter)}` +
            `&voice=${encodeURIComponent(voice)}&lengthScale=${currentScale()}`);
        const data = await res.json();
        return data.ok ? data : null;
    } catch {
        return null;
    }
}

/**
 * @param {object}  options
 * @param {boolean} options.force  rebuild every paragraph, not just changed ones
 * @param {boolean} options.quiet  a background pass after a save: no stopping
 *                                 playback, no taking over the status line
 *
 * Pressing Render with nothing changed used to run a full pass that rebuilt
 * nothing while showing a progress bar - all the appearance of work and none
 * of it. It now says so and stops.
 */
async function renderChapter({ force = false, quiet = false } = {}) {
    const voice = currentVoice();
    if (!voice) {
        if (!quiet) setNarratorStatus('Choose a voice in the Narrator menu first.');
        return;
    }
    if (!doc.story || !doc.chapter) {
        if (!quiet) setNarratorStatus('Open a chapter first.');
        return;
    }

    // Unsaved text would be rendered from the copy on disk, which is not the
    // one on screen. Saving first is what the writer meant. (A quiet pass is
    // already the consequence of a save, so there is nothing to flush.)
    if (dirty && !quiet) await save();

    if (!force) {
        const plan = await audioPlan();
        if (plan && plan.pending === 0) {
            if (!quiet) setNarratorStatus(`Already up to date. ${minutes(playerSummary()?.seconds)}.`);
            return;
        }
    }

    if (!quiet) stopPlayer();
    els.renderBtn.disabled = true;
    els.rerenderBtn.disabled = true;
    if (!quiet) {
        setNarratorStatus(force
            ? 'Rebuilding complete chapter narration'
            : 'Rendering changed paragraphs', null, true);
        setProgress(0);
    }

    try {
        const res = await fetch('/api/narrator/audio/render', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ story: doc.story, chapter: doc.chapter, voice, force, lengthScale: currentScale() })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.message);

        await playerLoad(doc.story, doc.chapter);
        setProgress(null);
        const { rendered, reused } = data.manifest;
        setNarratorStatus(`Rendered ${rendered}, reused ${reused}. ${minutes(data.manifest.seconds)}.`);
        setTransport(true);
    } catch (err) {
        setProgress(null);
        setNarratorStatus(`Render failed: ${err.message}`);
    } finally {
        els.renderBtn.disabled = false;
        els.rerenderBtn.disabled = false;
    }
}

/**
 * Bring the audio up to date a little after a save, when the writer has asked
 * for that.
 *
 * Debounced because saving is not a rare event - there is an autosave every
 * four seconds and Ctrl+S on top of it - and each pass costs a plan and a
 * couple of fetches even when there is nothing to do. The wait is long enough
 * that a working writer never triggers it mid-sentence, and short enough that
 * stepping away for a moment leaves the audio current.
 */
const RENDER_AFTER_SAVE_MS = 8000;
let saveRenderTimer = null;

function scheduleRenderAfterSave() {
    if (!renderOnSaveEnabled()) return;

    clearTimeout(saveRenderTimer);
    saveRenderTimer = setTimeout(() => {
        saveRenderTimer = null;
        // Not while the writer is listening: a render mid-playback would pull
        // files out from under the player as it sweeps.
        if (isPlaying()) return;
        renderChapter({ quiet: true });
    }, RENDER_AFTER_SAVE_MS);
}

function renderOnSaveEnabled() {
    try {
        return localStorage.getItem('narrator_render_on_save') === 'true';
    } catch {
        return false;
    }
}

function currentVoice() {
    try {
        return localStorage.getItem('narrator_voice');
    } catch {
        return null;
    }
}

/**
 * Reading pace, as Piper's length_scale.
 *
 * Read here rather than imported so the plan and the render cannot end up
 * using different values - the scale is part of every segment hash, and a plan
 * computed at one pace would report every paragraph as pending against a
 * render done at another.
 */
function currentScale() {
    try {
        const raw = Number(localStorage.getItem('narrator_length_scale'));
        return Number.isFinite(raw) && raw >= 1 && raw <= 2 ? raw : 1.45;
    } catch {
        return 1.45;
    }
}

function setTransport(enabled) {
    [els.playBtn, els.prevBtn, els.nextBtn].forEach(b => { if (b) b.disabled = !enabled; });
}

/** @param {number|null} fraction  null hides the bar entirely. */
function setProgress(fraction) {
    if (!els.progress) return;
    els.progress.classList.toggle('hidden', fraction === null);
    if (fraction !== null && els.progressBar) {
        els.progressBar.style.width = `${Math.round(fraction * 100)}%`;
    }
}

function minutes(seconds) {
    const total = Math.round(seconds || 0);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m ? `${m}m ${s}s` : `${s}s`;
}

function setNarratorStatus(line, paragraph, working = false) {
    if (!els.narratorStatus) return;

    const dots = working
        ? '<span class="narrator__dots" aria-hidden="true"><i></i><i></i><i></i></span>'
        : '';

    els.narratorStatus.innerHTML = paragraph
        ? `${escapeHtml(line)}${dots}<p class="narrator__now">${escapeHtml(paragraph)}</p>`
        : `${escapeHtml(line)}${dots}`;
}

/* ---------- checking ---------- */

async function loadCriticOptions() {
    try {
        const res = await fetch('/api/critic/options');
        const data = await res.json();
        if (!data.ok) return;

        els.lens.innerHTML = '';
        data.lenses.forEach(l => {
            const o = document.createElement('option');
            o.value = l.id; o.textContent = l.label; o.title = l.blurb;
            if (l.id === data.defaultLens) o.selected = true;
            els.lens.appendChild(o);
        });

        els.engine.innerHTML = '';
        data.engines.forEach(e => {
            const o = document.createElement('option');
            o.value = e.id;
            o.textContent = e.ok ? e.label : `${e.label} (unavailable)`;
            o.title = e.ok ? e.blurb : e.reason;
            o.disabled = !e.ok;
            if (e.id === data.defaultEngine && e.ok) o.selected = true;
            els.engine.appendChild(o);
        });
    } catch (err) {
        console.error('[Editor] Could not load critic options', err);
    }
}

function busy(button, on, label) {
    button.disabled = on;
    if (on) {
        button.dataset.idle = button.textContent;
        button.textContent = label;
    } else if (button.dataset.idle) {
        button.textContent = button.dataset.idle;
    }
}

async function runSpelling() {
    busy(els.spellBtn, true, '...');
    try {
        // The story is what keys the dictionary. Sending no key was the whole
        // bug: the checker loaded an empty custom word list, so a word added
        // from this panel went on being reported as unknown for ever.
        const res = await fetch('/api/proofing/spell', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: surface.getValue(), seriesFolder: doc.story })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.message);
        renderSpelling(data);
    } catch (err) {
        els.output.innerHTML = `<p class="text-danger">${escapeHtml(err.message)}</p>`;
    } finally {
        busy(els.spellBtn, false);
    }
}

async function runScan() {
    busy(els.scanBtn, true, 'scanning...');
    els.output.innerHTML = '<p class="text-accent">Checking spelling, then waking the local model. Suggestions arrive when it finishes.</p>';
    try {
        const res = await fetch('/api/proofing/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: surface.getValue(),
                socketId: window.socket?.id,
                target: { document: [doc.story, doc.chapter].filter(Boolean).join(' / ') }
            })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.message);

        renderSpelling(data.spelling);
        if (!data.suggestionsPending) {
            els.output.insertAdjacentHTML('beforeend',
                `<p class="text-muted italic">${escapeHtml(data.suggestionsUnavailable || 'Edit suggestions unavailable.')}</p>`);
        } else {
            els.output.insertAdjacentHTML('beforeend',
                '<p class="text-muted italic" id="editorPending">Waiting on the local model for edit suggestions...</p>');
        }
    } catch (err) {
        els.output.innerHTML = `<p class="text-danger">${escapeHtml(err.message)}</p>`;
    } finally {
        busy(els.scanBtn, false);
    }
}

async function runCritique() {
    const range = surface.getSelection();
    const selection = surface.getValue().substring(range.from, range.to);
    const body = selection.trim() || surface.getValue();
    if (!body.trim()) return;

    busy(els.critiqueBtn, true, 'thinking...');
    els.output.innerHTML = `<p class="text-accent">Running the ${els.lens.value} pass${selection.trim() ? ' on your selection' : ''}. The local model takes a few minutes.</p>`;
    try {
        const res = await fetch('/api/critic/text', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: body, lens: els.lens.value, engine: els.engine.value })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.message);
        els.output.innerHTML = renderMarkdown(data.critique);
    } catch (err) {
        els.output.innerHTML = `<p class="text-danger">${escapeHtml(err.message)}</p>`;
    } finally {
        busy(els.critiqueBtn, false);
    }
}

function renderSpelling(spelling) {
    if (!spelling) return;
    const { findings, unknownCount, wordCount } = spelling;

    if (!findings.length) {
        els.output.innerHTML =
            `<h4>Spelling</h4><p class="text-muted">Nothing unknown in ${wordCount.toLocaleString()} words.</p>`;
        return;
    }

    const rows = findings.map(f => {
        const lines = f.occurrences.map(o => o.line).join(', ');
        const sugg = f.suggestions.length
            ? `<span class="editor__sugg">${f.suggestions.map(escapeHtml).join(', ')}</span>`
            : '<span class="text-muted">no suggestion</span>';
        return `<li><strong>${escapeHtml(f.word)}</strong>${f.count > 1 ? ` <em>&times;${f.count}</em>` : ''}
                <span class="text-muted">line ${escapeHtml(lines)}</span><br>${sugg}
                <button class="editor__add" data-word="${escapeHtml(f.word)}">add to dictionary</button></li>`;
    }).join('');

    els.output.innerHTML =
        `<h4>Spelling</h4><p class="text-muted">${unknownCount} unknown of ${wordCount.toLocaleString()} words.</p>
         <ul class="editor__list">${rows}</ul>`;

    els.output.querySelectorAll('.editor__add').forEach(btn => {
        btn.addEventListener('click', () => addToDictionary(btn.dataset.word, btn));
    });
}

/**
 * Adds a word to this story's dictionary, and means it.
 *
 * The old version wrote under a leftover comic-era series id while the spell
 * check read a different key entirely, so the word reappeared as unknown every
 * single time. Both sides now use the open story.
 */
async function addToDictionary(word, btn) {
    if (!doc.story) {
        btn.textContent = 'open a story first';
        return;
    }

    try {
        const res = await fetch('/api/dictionary', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scope: 'story', story: doc.story, word })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.message);

        btn.textContent = 'added';
        btn.disabled = true;

        // So the Dictionary page shows it without a reload.
        document.dispatchEvent(new CustomEvent('dictionaryChanged', { detail: { story: doc.story } }));
    } catch (err) {
        btn.textContent = 'failed: ' + err.message;
    }
}

function currentSeriesFolder() {
    return window.EDITOR_SESSION?.seriesFolder
        || localStorage.getItem('globalSeries')
        || 'default';
}

function renderSuggestions(payload) {
    document.getElementById('editorPending')?.remove();

    if (!payload.ok) {
        els.output.insertAdjacentHTML('beforeend',
            `<p class="text-danger">${escapeHtml(payload.message || 'Suggestion scan failed.')}</p>`);
        return;
    }
    if (!payload.suggestions.length) {
        els.output.insertAdjacentHTML('beforeend', '<h4>Edits</h4><p class="text-muted">No edits proposed.</p>');
        return;
    }

    const rows = payload.suggestions.map((s, i) => `
        <li>
            <blockquote>${escapeHtml(s.original)}</blockquote>
            <div class="editor__replacement">${escapeHtml(s.replacement)}</div>
            <p class="text-muted">${escapeHtml(s.reason)}</p>
            <button class="editor__apply" data-index="${i}">apply</button>
        </li>`).join('');

    els.output.insertAdjacentHTML('beforeend', `<h4>Edits</h4><ul class="editor__list">${rows}</ul>`);

    els.output.querySelectorAll('.editor__apply').forEach(btn => {
        btn.addEventListener('click', () => applySuggestion(payload.suggestions[Number(btn.dataset.index)], btn));
    });
}

/**
 * Apply an edit at its recorded offset. The offset is only trustworthy against
 * the text that was scanned, so re-verify the span still reads as expected
 * before touching the document — the writer may have kept typing.
 */
function applySuggestion(s, btn) {
    const text = surface.getValue();
    if (text.substr(s.offset, s.length) !== s.original) {
        btn.textContent = 'text moved — reload and rescan';
        btn.disabled = true;
        return;
    }
    // keepHistory: this is an edit to the writer's document, so Ctrl+Z must
    // take it back off again.
    surface.setValue(
        text.slice(0, s.offset) + s.replacement + text.slice(s.offset + s.length),
        { keepHistory: true }
    );
    btn.textContent = 'applied';
    btn.disabled = true;
    updateCounts();
    markDirty();
}
