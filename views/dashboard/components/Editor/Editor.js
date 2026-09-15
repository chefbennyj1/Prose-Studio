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
 * Checking runs in four tiers, in order of what each one costs:
 *   - the browser spellchecks live, for free, as you type
 *   - "Grammar & mechanics" is regex on the server: punctuation, dialogue
 *     mechanics, the grammar a parser is not needed for, and paragraph layout.
 *     Milliseconds, so it can be run as often as the writer likes
 *   - "Spelling" runs the server dictionary, which reports what the browser
 *     cannot: a readable list, grouped and counted, seeded with character names
 *   - "Line edits" and "Critique" wake a model, which is why they are asked for
 *     rather than something that fires on every keystroke
 *
 * None of those are buttons here any more. The editor's right-hand panel was
 * carrying its own controls - two selects and three buttons - in the middle of
 * a writing surface; choosing what to check now lives in the studio rail's
 * Review menu, which dispatches `runReview`, and the panel is a results drawer
 * that opens when there is something to read and closes to give the width back.
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
import { compile as compileFlags } from './WritingFlags.js';

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

// The `runReview` listener is bound to `document` and so survives the section
// being torn down. See initEditor.
let reviewWired = false;

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
        saveIcon: document.getElementById('editorSaveIcon'),
        saveLabel: document.getElementById('editorSaveLabel'),
        panel: document.getElementById('editorPanel'),
        panelTitle: document.getElementById('editorPanelTitle'),
        panelClose: document.getElementById('editorPanelClose'),
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

    loadWritingFlags();

    // Which check to run, and how, is the rail's decision - see ReviewMenu.js.
    // The editor only knows how to run them and where to put the answer.
    //
    // Registered before the first await, and announced once it is live. The
    // rail is always on screen but this section is injected on navigation, so
    // a check started from another section arrives while the editor is still
    // being built; ReviewMenu waits for `editorReady` rather than firing into
    // a listener that does not exist yet.
    // Bound once for the life of the page, not once per visit. Sections are
    // rebuilt on navigation and this listener lives on `document`, so binding
    // it inside initEditor unguarded would leave the previous visit's listener
    // attached and run every check twice on the second visit, three times on
    // the third.
    if (!reviewWired) {
        document.addEventListener('runReview', (event) => {
            const detail = event.detail || {};
            if (detail.task === 'mechanics') runMechanics(detail.mechanics);
            else if (detail.task === 'overuse') runOveruse(detail.overuse);
            else if (detail.task === 'adverbs') runAdverbs(detail.adverbs);
            else if (detail.task === 'spelling') runSpelling();
            else if (detail.task === 'edits') runScan();
            else if (detail.task === 'critique') runCritique(detail.lens);
            else if (detail.task === 'thesaurus') runThesaurus();
        });
        /*
         * Ctrl+Shift+F, on `document` and inside the same guard.
         *
         * Bound here rather than in the CodeMirror keymap because the writer is
         * often not in the editor when they want it — the caret may be in the
         * search box itself, refining a query. A keymap entry only fires when
         * the surface has focus, which is exactly when you least need it.
         */
        document.addEventListener('keydown', (event) => {
            if (!document.getElementById('editorOutput')) return;   // not on this section

            if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
                event.preventDefault();
                openSearch();
                return;
            }

            // Ctrl+Shift+T, beside Ctrl+Shift+F. Bound here for the same
            // reason: the caret is not always in the surface when a writer
            // wants this, and a keymap entry only fires when it is.
            if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 't') {
                event.preventDefault();
                runThesaurus();
                return;
            }

            // Escape clears the marks without shutting the drawer, so the
            // results stay readable while the page goes quiet again.
            if (event.key === 'Escape' && surface) surface.clearHighlight();
        });

        reviewWired = true;
    }
    document.dispatchEvent(new CustomEvent('editorReady'));

    await openLastPlace();

    els.saveBtn.addEventListener('click', () => save());
    els.panelClose?.addEventListener('click', () => closeDrawer());
    document.getElementById('editorSearchBtn')?.addEventListener('click', () => openSearch());
    wireFormatBar();

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
    /*
     * Says where the work happens, because that is the honest distinction now.
     *
     * The old copy divided these by SPEED — "give them a minute" — which was
     * true of a local Gemma 3 4B and is not true of Gemini. What has not
     * changed, and matters more, is that spelling and mechanics never leave the
     * machine while line edits and critique are sent to Google. That is the
     * whole basis of the AI being opt-in, so the panel should say it rather
     * than talk about waiting.
     */
    els.output.innerHTML =
        '<p class="text-muted italic">Spelling and mechanics run on this machine and are instant. ' +
        'Line edits and critique send the chapter to Gemini.</p>';
}

function reportNoRoot() {
    storyRootReady = false;
    setState('no story folder');
    promptForSettings('No story folder is set.');
}

/* ---------- writing flags ---------- */

/**
 * WHICH FAMILIES ARE ON BY DEFAULT.
 *
 * Not all of them, and this is the whole design decision. Everything switched
 * on flags roughly one word in nine of ordinary prose, and a page with that
 * many underlines is a page a writer stops reading — the marks stop meaning
 * "look here" and start meaning "ignore me", which is worse than not having
 * them, because now the real ones are camouflaged too.
 *
 * On: the four families that are dense with signal in FICTION and quiet
 * otherwise. Off by default, and switchable on:
 *
 *   fillerAdverbs   139 adverbs, several of which ("immediately", "suddenly",
 *                   "quietly") are ordinary narrative verbs of motion. Useful
 *                   during a deliberate adverb pass; noise while drafting.
 *   nominalizations Written for technical prose. "utilization",
 *                   "deployment", "configuration" — a novel contains almost
 *                   none of these, so it is 245 terms earning nothing.
 *   aiVocabulary    The riskiest list. It contains "landscape", "profound",
 *                   "stark", "poignant", "enduring" — all of which are simply
 *                   words, and all of which a novelist may have chosen on
 *                   purpose. High value when hunting pasted AI text, high
 *                   false-positive rate the rest of the time.
 */
const FLAGS_ON_BY_DEFAULT = ['weasel', 'hedging', 'passiveVoice', 'aiPhrases', 'aiPatterns'];
const FLAGS_STORE_KEY = 'prose-engine-writing-flags';

// Compiled once for the life of the page. The JSON is 85KB and compiling it
// builds eight regexes; a section that is re-injected on every navigation must
// not redo either.
let compiledFlags = null;

/**
 * Fetch the word lists, compile them, and hand them to the surface.
 *
 * Called once, and never again as the writer types: the surface's view plugin
 * re-scans on every document change by itself. See Surface.setWritingFlags.
 *
 * Failure is silent by design. These are underlines under words the writer can
 * see perfectly well; a missing JSON is not worth a toast in front of someone
 * mid-sentence, and everything else in the editor works without it.
 */
async function loadWritingFlags() {
    try {
        if (!compiledFlags) {
            const response = await fetch('/resources/writing-flags.json');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            compiledFlags = compileFlags(await response.json());
        }
        surface?.setWritingFlags(compiledFlags, new Set(chosenFlagCategories()));
    } catch (err) {
        console.error('[Editor] Writing flags are off:', err.message);
    }
}

/** The writer's choice if they have made one, the defaults if not. */
function chosenFlagCategories() {
    try {
        const saved = JSON.parse(localStorage.getItem(FLAGS_STORE_KEY) || 'null');
        if (Array.isArray(saved)) return saved;
    } catch {
        // A corrupt entry is not worth losing the feature over.
    }
    return FLAGS_ON_BY_DEFAULT;
}

/**
 * Turn families on or off.
 *
 * The rail's Writing flags submenu owns this choice and announces it; the
 * editor only re-arms the surface. It writes localStorage too, so a choice
 * made before the editor was ever opened still applies when it is.
 *
 * @param {string[]} categories  category ids from writing-flags.json
 */
export function setWritingFlagCategories(categories) {
    const chosen = Array.isArray(categories) ? categories : FLAGS_ON_BY_DEFAULT;
    try {
        localStorage.setItem(FLAGS_STORE_KEY, JSON.stringify(chosen));
    } catch {
        // Private browsing. The choice still applies for this session.
    }
    surface?.setWritingFlags(compiledFlags, new Set(chosen));
}

/*
   Bound on the document, once for the life of the page, for the same reason
   `runReview` is: the rail is permanent and this section is rebuilt on every
   navigation, so the menu cannot hold a reference to the editor.
*/
document.addEventListener('writingFlagsChanged', (event) => {
    setWritingFlagCategories(event.detail?.categories);
});

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
        // Clear `dirty` first: setState redraws the Save button from it, so
        // setting the text before the flag left a freshly opened chapter
        // showing an unsaved floppy disk.
        dirty = false;
        setState('saved');
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
            drawSaveButton();
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

        // The story folder changed, so anything watching what is waiting to be
        // backed up needs to look again. See BackupButton.
        document.dispatchEvent(new CustomEvent('manuscriptSaved', {
            detail: { story: doc.story, chapter: doc.chapter }
        }));

        // The words on disk changed, so the audio for some paragraph is now
        // out of date. Brings it back in line if the writer asked for that.
        scheduleRenderAfterSave();
    } catch (err) {
        setState('error: ' + err.message);
    }
}

function setState(text) {
    if (els.state) els.state.textContent = text;
    drawSaveButton();
}

/**
 * The Save button says whether there is anything to save.
 *
 * Driven by `dirty` rather than by the status text beside it, because that
 * text carries transient things — "autosaving...", "conflict", an error
 * message — and the button is answering one question only: is the file on disk
 * the same as what is on screen.
 *
 * It stays enabled when saved. save() already returns early when there is
 * nothing to do, and a writer who presses Save out of habit should get a
 * button that acknowledges the press rather than one that looks broken.
 */
function drawSaveButton() {
    if (!els.saveBtn) return;

    els.saveBtn.classList.toggle('is-saved', !dirty);
    if (els.saveIcon) els.saveIcon.setAttribute('name', dirty ? 'save-outline' : 'checkmark-circle');
    if (els.saveLabel) els.saveLabel.textContent = dirty ? 'Save' : 'Saved';
    els.saveBtn.title = dirty ? 'Save this chapter' : 'Everything is saved';
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
/*
 * Bound once for the life of the page, not once per visit.
 *
 * The transport moved into the studio rail on 2026-08-13, and the rail is built
 * once and never torn down — unlike the editor section, which is re-injected on
 * every navigation. While these buttons lived in editor.html each visit got
 * fresh elements and therefore fresh listeners; now the elements persist, so
 * binding again on the second visit would leave the first visit's listener
 * attached and Next would skip TWO paragraphs, then three.
 *
 * Exactly the bug `reviewWired` exists to prevent, one floor down.
 */
let narratorWired = false;

function setUpNarrator() {
    if (!els.playBtn) return;
    if (narratorWired) {
        // Still refresh what depends on the open chapter; only the listeners
        // are once-only.
        showAudioState();
        return;
    }
    narratorWired = true;

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
    document.addEventListener('narratorSpeakerChanged', () => refreshAudio());

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
            `&voice=${encodeURIComponent(voice)}&lengthScale=${currentScale()}` +
            `&speaker=${currentSpeaker()}`);
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
            body: JSON.stringify({
                story: doc.story, chapter: doc.chapter, voice, force,
                lengthScale: currentScale(), speaker: currentSpeaker()
            })
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
/**
 * Which speaker within the current voice. Read from storage rather than
 * imported for the same reason as the pace: plan and render must agree, and
 * the speaker is part of every segment hash.
 */
function currentSpeaker() {
    try {
        const voice = currentVoice();
        const all = JSON.parse(localStorage.getItem('narrator_speakers') || '{}');
        const id = Number(all[voice]);
        return Number.isInteger(id) && id >= 0 ? id : 0;
    } catch {
        return 0;
    }
}

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

/* ---------- formatting ---------- */

/**
 * The formatting bar. Each button maps to a Markdown edit on the surface.
 *
 * One listener on the bar rather than one per button, and mousedown rather
 * than click: a click steals focus from the editor first, which collapses the
 * selection the writer just made, so Bold would arrive with nothing to wrap.
 * preventDefault on mousedown keeps the caret and the selection exactly where
 * they were.
 */
const FORMATS = {
    bold: (s) => s.toggleWrap('**'),
    italic: (s) => s.toggleWrap('*'),
    strike: (s) => s.toggleWrap('~~'),
    heading: (s) => s.toggleLinePrefix('## '),
    quote: (s) => s.toggleLinePrefix('> '),
    // Three asterisks is the convention a typesetter and a Markdown parser
    // both understand, which a row of hyphens or four blank lines is not.
    scene: (s) => s.insertBlock('***'),
    // U+2014. On a laptop there is no numeric keypad, so the Alt+0151 Windows
    // documents cannot be pressed at all - and this is the punctuation mark
    // fiction uses most after the comma.
    emdash: (s) => s.insertText('—')
};

function wireFormatBar() {
    const bar = document.querySelector('.editor__format');
    if (!bar) return;

    bar.addEventListener('mousedown', (event) => {
        const btn = event.target.closest('[data-format]');
        if (!btn) return;

        event.preventDefault();     // keep the selection; see above
        const apply = FORMATS[btn.dataset.format];
        if (!apply) return;

        apply(surface);
        markDirty();
        updateCounts();
    });
}

/* ---------- checking ---------- */

/**
 * The drawer.
 *
 * Opened by whatever has something to say and closed by the writer, because it
 * costs 340px of the page and an empty panel is not worth that. `hidden` rather
 * than a class: the aside genuinely has nothing in it between scans, and a
 * hidden element is one screen readers skip and CSS does not have to fight.
 */
function openDrawer(title) {
    if (!els.panel) return;
    els.panel.hidden = false;
    if (els.panelTitle && title) els.panelTitle.textContent = title;
}

function closeDrawer() {
    if (els.panel) els.panel.hidden = true;
    // Shutting the drawer means the writer is reading again, and a page still
    // wearing forty marks is harder to read than a clean one. The search itself
    // is remembered, so reopening puts the results and the marks straight back.
    surface?.clearHighlight();
}

/** Tell the rail what was found, so its badge can carry the number. */
function announce(total, error = 0) {
    document.dispatchEvent(new CustomEvent('reviewFinished', { detail: { total, error } }));
}

function working(title, message) {
    openDrawer(title);
    els.output.innerHTML = `<p class="text-accent">${escapeHtml(message)}</p>`;
}

function failed(err) {
    els.output.innerHTML = `<p class="text-danger">${escapeHtml(err.message)}</p>`;
    announce(0);
}

/**
 * Mechanics: punctuation, dialogue, grammar, layout.
 *
 * No model and no plugin behind this one - it is regex on the server and comes
 * back in milliseconds, which is why it is the check offered first and the one
 * that can be run as often as the writer likes.
 */
async function runMechanics(options) {
    if (!surface.getValue().trim()) {
        working('Mechanics', 'Nothing open to scan.');
        return;
    }

    working('Mechanics', 'Scanning...');
    try {
        const res = await fetch('/api/proofing/mechanics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: surface.getValue(), options: options || {} })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.message);
        renderMechanics(data);
    } catch (err) {
        failed(err);
    }
}

/* ---------- manuscript-wide search ---------- */

/**
 * Search across every chapter of the story.
 *
 * Ctrl+F is CodeMirror's, and stays: it searches the chapter you are in, which
 * is the common case and instant because the text is already in memory.
 * Ctrl+Shift+F is this - the whole book - matching the convention every editor
 * with more than one file uses.
 *
 * It reads FILES, so what is in the buffer has to be on disk first or the
 * chapter you are looking at is the one set of results that is wrong.
 */
const search = {
    query: '',
    caseSensitive: false,
    // Defaulted ON. Searching a character name is the commonest reason a
    // novelist searches at all, and "Rin" matching during/bring/wringing makes
    // the results useless for exactly that.
    wholeWord: true,
    results: null,
    running: false
};

function openSearch() {
    openDrawer('Search');
    drawSearch();
    const box = els.output.querySelector('#editorSearchInput');
    if (box) {
        box.focus();
        box.select();
    }
}

/**
 * The form, and the results under it.
 *
 * The form is redrawn with the results rather than kept separate, so there is
 * one render path and no way for the two to disagree about what was searched.
 * Focus and caret position are restored afterwards, because this redraws on
 * every result and the writer is often still typing.
 */
function drawSearch(message = '') {
    const results = search.results;
    const box = els.output.querySelector('#editorSearchInput');
    const hadFocus = document.activeElement === box;
    const caret = box ? box.selectionStart : null;

    /*
     * The button is a real submit, so Enter and the click are the same code
     * path rather than two that can drift.
     *
     * It exists because Enter alone is an invisible affordance - the same
     * mistake as shipping this whole panel on a shortcut nobody was told
     * about. A box with a button beside it is what every search on this
     * operating system looks like, and looking familiar is most of being
     * usable.
     */
    const form = `
        <form class="editor__search" id="editorSearchForm">
            <div class="editor__search-row">
                <input type="search" id="editorSearchInput" class="editor__search-input"
                    placeholder="Search this story" autocomplete="off" spellcheck="false"
                    value="${escapeHtml(search.query)}">
                <button type="submit" id="editorSearchGo" title="Search"
                    aria-label="Search"
                    class="glass glass-btn glass-btn--primary editor__search-go">
                    <ion-icon name="search-outline" aria-hidden="true"></ion-icon>
                </button>
            </div>
            <div class="editor__search-opts">
                <label><input type="checkbox" id="editorSearchWhole"
                    ${search.wholeWord ? 'checked' : ''}> Whole word</label>
                <label><input type="checkbox" id="editorSearchCase"
                    ${search.caseSensitive ? 'checked' : ''}> Match case</label>
            </div>
        </form>`;

    let body = '';
    if (message) {
        body = `<p class="text-muted">${escapeHtml(message)}</p>`;
    } else if (results) {
        body = results.total
            ? renderSearchResults(results)
            : `<p class="text-muted">No matches for “${escapeHtml(results.query)}” in ${results.searched} chapter(s).</p>`;
    }

    els.output.innerHTML = form + body;
    wireSearch();

    const next = els.output.querySelector('#editorSearchInput');
    if (next && hadFocus) {
        next.focus();
        if (caret !== null) next.setSelectionRange(caret, caret);
    }
}

function renderSearchResults(results) {
    const head = `${results.total} match${results.total === 1 ? '' : 'es'} in
        ${results.chapters.length} of ${results.searched} chapter(s)`;

    const groups = results.chapters.map((group, gi) => {
        const hits = group.hits.map((hit, hi) => `
            <li>
                <button class="editor__search-hit" data-group="${gi}" data-hit="${hi}">
                    <span class="editor__search-line">${hit.line}</span>
                    <span class="editor__search-text">${escapeHtml(hit.before)}<mark>${escapeHtml(hit.match)}</mark>${escapeHtml(hit.after)}</span>
                </button>
            </li>`).join('');

        // The per-chapter count answers "which chapter is this in" at a glance,
        // which is most of why a novelist searches their own book.
        return `
            <div class="editor__search-group">
                <h5>${escapeHtml(group.chapter)} <span class="text-muted">${group.count}</span></h5>
                <ul class="editor__search-hits">${hits}</ul>
            </div>`;
    }).join('');

    const capped = results.truncated
        ? `<p class="text-muted">Some chapters have more matches than are listed.</p>`
        : '';

    return `<p class="text-muted">${head}</p>${capped}${groups}`;
}

function wireSearch() {
    const form = els.output.querySelector('#editorSearchForm');
    if (!form) return;

    const input = form.querySelector('#editorSearchInput');
    const whole = form.querySelector('#editorSearchWhole');
    const matchCase = form.querySelector('#editorSearchCase');

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        search.query = input.value;
        runSearch();
    });

    // Enter searches; the toggles re-search immediately, because changing one
    // with results on screen and nothing happening reads as a broken control.
    [whole, matchCase].forEach((toggle) => {
        toggle.addEventListener('change', () => {
            search.wholeWord = whole.checked;
            search.caseSensitive = matchCase.checked;
            search.query = input.value;
            if (search.query.trim()) runSearch();
        });
    });

    els.output.querySelectorAll('.editor__search-hit').forEach((btn) => {
        btn.addEventListener('click', () => {
            const group = search.results.chapters[Number(btn.dataset.group)];
            jumpToHit(group.chapter, group.hits[Number(btn.dataset.hit)]);
        });
    });
}

/**
 * The button's busy state, set directly rather than by redrawing.
 *
 * drawSearch rebuilds the whole form, which would take the caret out of the box
 * mid-keystroke; every path out of runSearch redraws anyway, so the button only
 * ever needs putting INTO the busy state, never out of it.
 */
function setSearchBusy(busy) {
    const btn = els.output.querySelector('#editorSearchGo');
    if (!btn) return;

    btn.disabled = busy;
    // Icon-only, so the busy state has to be carried by the icon rather than by
    // a label. aria-label moves with it: "Search" on a button that is mid-search
    // and cannot be pressed is the wrong thing to read out.
    btn.querySelector('ion-icon')?.setAttribute('name', busy ? 'hourglass-outline' : 'search-outline');
    btn.setAttribute('aria-label', busy ? 'Searching' : 'Search');
    btn.setAttribute('aria-busy', String(busy));
}

async function runSearch() {
    if (!doc.story) {
        drawSearch('Open a story first.');
        return;
    }
    if (!search.query.trim()) {
        search.results = null;
        drawSearch();
        return;
    }
    if (search.running) return;

    // Reads files, so the open chapter has to be on disk or its own results are
    // the one set that is stale.
    if (dirty) await save();

    search.running = true;
    // A whole-manuscript search reads every chapter off disk, so on a long
    // novel there is a real pause. Say so on the button the writer just
    // pressed, rather than leaving it looking like the click missed.
    setSearchBusy(true);
    try {
        const res = await fetch('/api/manuscript/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                story: doc.story,
                query: search.query,
                caseSensitive: search.caseSensitive,
                wholeWord: search.wholeWord
            })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.message);

        search.results = data;
        drawSearch();
        announce(data.total, 0);

        // Mark the hits in whatever chapter is already on screen.
        surface.setHighlight(search.query, {
            caseSensitive: search.caseSensitive,
            wholeWord: search.wholeWord
        });
    } catch (err) {
        search.results = null;
        drawSearch(err.message);
    } finally {
        search.running = false;
    }
}

/**
 * Open the chapter a hit is in and put the caret on it.
 *
 * The highlight is re-applied AFTER the chapter loads, not before: loading a
 * chapter rebuilds the editor state from scratch to drop the old undo history,
 * and that takes the highlight field's value with it. Setting it first would
 * look like it worked and mark nothing.
 */
async function jumpToHit(chapter, hit) {
    if (chapter !== doc.chapter) await openChapter(chapter);

    // openChapter refuses when the buffer is dirty and the writer keeps their
    // changes. An offset is valid in any chapter, so without this the jump
    // would silently land on the wrong sentence in the chapter still open.
    if (chapter !== doc.chapter) return;

    surface.setHighlight(search.query, {
        caseSensitive: search.caseSensitive,
        wholeWord: search.wholeWord
    });
    surface.setSelection(hit.offset, hit.offset + hit.length);
    surface.focus();
}

/**
 * Overused words, across the whole story.
 *
 * The only check that does not read the surface. It scans the FILES, which
 * means it reports on what is saved rather than what is on screen - so it is
 * saved first when there is anything pending, otherwise a writer who has just
 * cut forty "just"s would be shown the forty they have already fixed.
 */
async function runOveruse(options = {}) {
    if (!doc.story) {
        working('Overused words', 'Open a story first.');
        return;
    }

    if (dirty) await save();

    working('Overused words', options.judge ? 'Counting, then asking Gemini...' : 'Counting across the story...');
    try {
        const res = await fetch('/api/proofing/overuse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                story: doc.story,
                options: { disabled: options.disabled || [] },
                judge: !!options.judge
            })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.message);
        renderOveruse(data);
    } catch (err) {
        failed(err);
    }
}

/**
 * Weak adverbs, across the whole story.
 *
 * Reads the FILES rather than the surface, the same as runOveruse and with the
 * same consequence: what is on screen and unsaved would not be counted, so the
 * buffer is written first. A writer who has just cut thirty "carefully"s should
 * not be shown the thirty they have already fixed.
 */
async function runAdverbs(options = {}) {
    if (!doc.story) {
        working('Weak adverbs', 'Open a story first.');
        return;
    }

    if (dirty) await save();

    working('Weak adverbs', 'Counting across the story...');
    try {
        const res = await fetch('/api/proofing/adverbs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                story: doc.story,
                options: { disabled: options.disabled || [] }
            })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.message);
        renderAdverbs(data);
    } catch (err) {
        failed(err);
    }
}

async function runSpelling() {
    working('Spelling', 'Checking...');
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
        announce(data.findings.length, data.findings.length);
    } catch (err) {
        failed(err);
    }
}

/**
 * Line edits, and nothing else.
 *
 * `parts` is what keeps that promise. This endpoint runs spelling, mechanics
 * and the model's suggestions, and it used to run all three here — so a writer
 * who pressed "Line edits" got a spelling list and a mechanics list first and
 * had to scroll past both to reach the thing they asked for, which was still
 * loading. Spelling and mechanics have their own rows in the rail.
 */
async function runScan() {
    if (!surface.getValue().trim()) {
        working('Line edits', 'Nothing open to scan.');
        return;
    }

    // "Waking the local model ... a few minutes" was Gemma 3 4B, which had a
    // ~60s cold load. Gemini has no cold start and answers in seconds, so the
    // old copy told the writer to go and do something else for no reason. What
    // it should say instead is where the chapter is going.
    working('Line edits', 'Sending this chapter to Gemini. Edits arrive when it answers.');
    try {
        const res = await fetch('/api/proofing/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: surface.getValue(),
                socketId: window.socket?.id,
                parts: ['suggestions'],
                target: { document: [doc.story, doc.chapter].filter(Boolean).join(' / ') }
            })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.message);

        if (!data.suggestionsPending) {
            els.output.innerHTML =
                `<p class="text-muted italic">${escapeHtml(data.suggestionsUnavailable || 'Edit suggestions are unavailable.')}</p>`;
            announce(0);
        } else {
            els.output.innerHTML =
                '<p class="text-muted italic" id="editorPending">Waiting on Gemini for edit suggestions...</p>';
        }
    } catch (err) {
        failed(err);
    }
}

async function runCritique(lens) {
    const range = surface.getSelection();
    const selection = surface.getValue().substring(range.from, range.to);
    const body = selection.trim() || surface.getValue();
    if (!body.trim()) return;

    working('Critique', `Running the ${lens || 'critique'} pass${selection.trim() ? ' on your selection' : ''}. The model takes a few minutes.`);
    try {
        const res = await fetch('/api/critic/text', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: body, lens })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.message);
        els.output.innerHTML = renderMarkdown(data.critique);
        announce(0);
    } catch (err) {
        failed(err);
    }
}

/**
 * Mechanics findings.
 *
 * Grouped, errors before style, each one showing the line it sits on and the
 * text around it — a finding whose quote is a single comma is unreadable on its
 * own, so the context travels with it and the span is marked inside that.
 *
 * "Fix" appears only where the scanner has an answer it is sure of. The rest —
 * fragments, long paragraphs, two speakers in one paragraph — are things only
 * the writer can resolve, and offering a machine rewrite of those would be
 * worse than offering nothing.
 */
function renderMechanics(payload, { append = false } = {}) {
    const { findings, counts, stats } = payload;

    // When appended to a full scan the badge is the caller's to set, because
    // the mechanics count alone would silently drop the spelling findings
    // sitting directly above it in the same drawer.
    if (!append) {
        openDrawer('Mechanics');
        announce(counts.total, counts.error);
    }

    if (!findings.length) {
        const clean = `<h4>Mechanics</h4><p class="text-muted">Nothing to flag in ${stats.words.toLocaleString()} words.</p>`;
        if (append) els.output.insertAdjacentHTML('beforeend', clean);
        else els.output.innerHTML = clean;
        return;
    }

    const order = { error: 0, style: 1 };
    const sorted = [...findings].sort((a, b) =>
        (order[a.severity] - order[b.severity]) || a.offset - b.offset);

    const rows = sorted.map((finding, index) => {
        const fix = finding.replacement === null
            ? ''
            : `<button class="editor__apply" data-mech="${index}">fix</button>`;

        return `<li class="editor__finding editor__finding--${escapeHtml(finding.severity)}">
                <div class="editor__finding-head">
                    <strong>${escapeHtml(finding.label)}</strong>
                    <span class="text-muted">line ${finding.line}</span>
                </div>
                <blockquote>${markQuote(finding)}</blockquote>
                <p class="text-muted">${escapeHtml(finding.message)}</p>
                ${finding.replacement === null ? '' :
                `<div class="editor__replacement">${escapeHtml(finding.replacement)}</div>`}
                <!--
                    "go to", not "jump". This selects the finding in the
                    manuscript and does nothing else — it changes no text.
                    Sitting beside "fix", which does, the old label read as if
                    it were the other half of a pair and therefore as if it
                    dismissed the finding. Ben read it as "ignore". A control
                    that is guessed wrong is worse than a longer one.

                    There IS no per-finding ignore. The only way to silence a
                    rule is its toggle in the Review menu, which switches it off
                    everywhere — deliberately, because fiction breaks grammar on
                    purpose and a writer whose voice lives in fragments wants
                    the rule gone, not dismissed 200 times.
                -->
                <div class="editor__finding-actions">
                    ${fix}<button class="editor__jump" data-mech="${index}"
                        title="Select this in the manuscript">go to</button>
                </div>
            </li>`;
    }).join('');

    const summary = `${counts.error} to fix, ${counts.style} to consider &middot;
        ${stats.sentences.toLocaleString()} sentences, ${stats.averageSentence} words average,
        ${stats.dialoguePercent}% dialogue`;

    const html = `<h4>Mechanics</h4><p class="text-muted">${summary}</p>
                  <ul class="editor__list">${rows}</ul>`;

    if (append) els.output.insertAdjacentHTML('beforeend', html);
    else els.output.innerHTML = html;

    els.output.querySelectorAll('.editor__apply[data-mech]').forEach((btn) => {
        btn.addEventListener('click', () => applyMechanics(sorted[Number(btn.dataset.mech)], btn, sorted));
    });
    els.output.querySelectorAll('.editor__jump[data-mech]').forEach((btn) => {
        const finding = sorted[Number(btn.dataset.mech)];
        btn.addEventListener('click', () => {
            surface.setSelection(finding.offset, finding.offset + finding.length);
            surface.focus();
        });
    });
}

/**
 * The overused-word report.
 *
 * Ordered by RATE, not by raw count. "the" would win any count, and in a
 * 120,000-word novel so would half this list; per 10,000 words is the number
 * that answers "is this a lot", which is the only question the writer is
 * actually asking.
 *
 * Every row shows the narration/dialogue split rather than one total. A
 * character who talks in absolutes is characterised, not sloppy, so a writer
 * with a lot of dialogue would otherwise be told they have a problem they do
 * not have.
 */
function renderOveruse(payload) {
    const { words, stats, counts, judgement } = payload;

    openDrawer('Overused words');
    announce(counts.total, 0);

    if (!words.length) {
        els.output.innerHTML = `<h4>Overused words</h4>
            <p class="text-muted">Nothing counted across ${stats.words.toLocaleString()} words.</p>`;
        return;
    }

    const verdicts = new Map((judgement?.verdicts || []).map(v => [v.word, v]));

    const rows = [...words]
        .sort((a, b) => b.per10k - a.per10k || b.total - a.total)
        .map((row, index) => {
            const verdict = verdicts.get(row.word);
            const tag = verdict
                ? `<span class="editor__verdict editor__verdict--${escapeHtml(verdict.verdict)}">${escapeHtml(verdict.verdict)}</span>`
                : '';

            // The split is the honest number. Narration first, because that is
            // the half the writer controls as a stylist rather than as a
            // ventriloquist.
            const split = row.dialogue
                ? `${row.narration} narration &middot; ${row.dialogue} dialogue`
                : `${row.narration} in narration`;

            const samples = (row.occurrences || []).slice(0, 3).map((occ, i) => `
                <li>
                    <blockquote>${escapeHtml(occ.context)}</blockquote>
                    <button class="editor__jump" data-overuse="${index}" data-occ="${i}"
                        title="${escapeHtml(occ.chapter)}">${escapeHtml(occ.chapter)}, line ${occ.line}</button>
                </li>`).join('');

            return `<li class="editor__finding">
                <div class="editor__finding-head">
                    <strong>${escapeHtml(row.word)}</strong>
                    <span class="text-muted">${row.total} &middot; ${row.per10k}/10k</span>
                    ${tag}
                </div>
                <p class="text-muted">${split} &middot; ${row.chapters.length} chapter(s)</p>
                ${verdict ? `<p>${escapeHtml(verdict.comment)}</p>` : `<p class="text-muted">${escapeHtml(row.note)}</p>`}
                <ul class="editor__samples">${samples}</ul>
            </li>`;
        }).join('');

    const head = `${counts.total.toLocaleString()} use(s) of ${stats.distinct} word(s) &middot;
        ${counts.per10k}/10k &middot; ${stats.words.toLocaleString()} words, ${stats.chapters} chapter(s)`;

    // A failed judgement is a note, never a replacement for the numbers: the
    // counts are the part the writer can act on and they are already correct.
    const opinion = judgement?.error
        ? `<p class="text-danger">Counts are exact. Gemini could not be reached: ${escapeHtml(judgement.error)}</p>`
        : (judgement?.summary ? `<p class="editor__summary">${escapeHtml(judgement.summary)}</p>` : '');

    els.output.innerHTML = `<h4>Overused words</h4><p class="text-muted">${head}</p>
        ${opinion}<ul class="editor__list">${rows}</ul>`;

    /*
     * Jumping is cross-chapter, which no other check in this panel is.
     *
     * The offsets belong to the file the hit was found in, so applying one to
     * whatever happens to be open would land in the wrong place in the wrong
     * chapter - silently, since an offset is always valid somewhere. The
     * chapter is opened first and the selection made only once it is loaded.
     */
    const sorted = [...words].sort((a, b) => b.per10k - a.per10k || b.total - a.total);
    els.output.querySelectorAll('.editor__jump[data-overuse]').forEach((btn) => {
        const row = sorted[Number(btn.dataset.overuse)];
        const occ = row.occurrences[Number(btn.dataset.occ)];
        btn.addEventListener('click', async () => {
            if (occ.chapter !== doc.chapter) await openChapter(occ.chapter);

            // openChapter refuses when the buffer is dirty and the writer keeps
            // their changes, and it returns either way. Without this the
            // selection would then be applied to the chapter still on screen -
            // at an offset that is valid there too, so it would look like a
            // working jump to the wrong sentence.
            if (occ.chapter !== doc.chapter) return;

            surface.setSelection(occ.offset, occ.offset + occ.quote.length);
            surface.focus();
        });
    });
}

/**
 * The weak-adverb report.
 *
 * Ordered by how much of the word is CLASSIFIED, not by how often it occurs.
 *
 * Count order would put "finally" and "really" at the top of every manuscript
 * ever written, which is the number every other tool reports and the reason
 * nobody acts on it. A word with nine redundant uses and a word with nine
 * hundred loose ones are not the same finding, and the first is the one with an
 * edit attached, so classified hits sort first and the flat -ly words sink to
 * the bottom where they belong - present, countable, and not shouting.
 */
function renderAdverbs(payload) {
    const { words, kinds, stats, counts, names } = payload;

    openDrawer('Weak adverbs');
    announce(counts.total, 0);

    if (!words.length) {
        els.output.innerHTML = `<h4>Weak adverbs</h4>
            <p class="text-muted">Nothing counted across ${stats.words.toLocaleString()} words.</p>`;
        return;
    }

    const actionable = row => row.kinds.redundant + row.kinds.tag + row.kinds.propping;
    const sorted = [...words].sort((a, b) =>
        actionable(b) - actionable(a) || b.per10k - a.per10k || a.word.localeCompare(b.word));

    const rows = sorted.map((row, index) => {
        // Only the kinds this word actually has. A row of four chips where
        // three read "0" is noise pretending to be data.
        const chips = (kinds || [])
            .filter(kind => row.kinds[kind.id])
            .map(kind => `<span class="editor__verdict editor__verdict--${escapeHtml(kind.id)}"
                title="${escapeHtml(kind.note || '')}">${row.kinds[kind.id]} ${escapeHtml(kind.label.toLowerCase())}</span>`)
            .join('');

        // The split is the honest number, and it matters more here than
        // anywhere: people talk in adverbs. A character saying "I walked
        // really slowly" is characterised, not sloppy.
        const split = row.dialogue
            ? `${row.narration} narration &middot; ${row.dialogue} dialogue`
            : `${row.narration} in narration`;

        /*
         * The instances are a <details>, and they are EMPTY until it is opened.
         *
         * Three samples with a jump button each was the first shape, and it was
         * wrong in the way Ben spotted: a word with thirty-four uses showed
         * three of them and offered no way to the other thirty-one, which is
         * the one thing the search has always done properly.
         *
         * Listing them all up front is the obvious fix and it does not survive
         * contact with a novel. Three hundred distinct adverbs carrying every
         * occurrence is several thousand list items built in one innerHTML, on
         * a panel whose whole job is to open instantly. So the summary row is
         * always built and the list is filled once, on first open - see the
         * toggle handler below.
         */
        const label = row.total === 1 ? '1 instance' : `${row.total} instances`;

        return `<li class="editor__finding">
            <div class="editor__finding-head">
                <strong>${escapeHtml(row.word)}</strong>
                <span class="text-muted">${row.total} &middot; ${row.per10k}/10k</span>
            </div>
            <p class="editor__kinds">${chips}</p>
            <p class="text-muted">${split} &middot; ${row.chapters.length} chapter(s)</p>
            <details class="editor__instances" data-adverb="${index}">
                <summary>${label}</summary>
                <ul class="editor__search-hits"></ul>
            </details>
        </li>`;
    }).join('');

    const tally = (kinds || []).filter(kind => kind.total)
        .map(kind => `${escapeHtml(kind.label)} ${kind.total}`).join(' &middot; ');

    const head = `${counts.total.toLocaleString()} adverb(s), ${stats.distinct} distinct &middot;
        ${counts.per10k}/10k &middot; ${stats.words.toLocaleString()} words, ${stats.chapters} chapter(s)`;

    /*
     * The names are shown, and that is not a footnote.
     *
     * The scan decides that "Emily" is a person rather than an adverb by
     * looking at how the whole manuscript capitalises it, and that decision is
     * a guess that can go wrong in both directions. Printing the list is what
     * makes it checkable: a writer who sees a real adverb in it knows why the
     * count looks low, and a writer whose protagonist is missing from it knows
     * why she is suddenly at the top of the report.
     */
    const skipped = (names && names.length)
        ? `<p class="text-muted">Treated as names, not adverbs: ${names.map(escapeHtml).join(', ')}</p>`
        : '';

    els.output.innerHTML = `<h4>Weak adverbs</h4>
        <p class="text-muted">${head}</p>
        ${tally ? `<p class="editor__summary">${tally}</p>` : ''}
        ${skipped}
        <ul class="editor__list">${rows}</ul>`;

    els.output.querySelectorAll('.editor__instances[data-adverb]').forEach((details) => {
        const row = sorted[Number(details.dataset.adverb)];
        details.addEventListener('toggle', () => {
            if (!details.open || details.dataset.filled) return;
            details.dataset.filled = '1';
            fillAdverbInstances(details, row);
        });
    });
}

/**
 * One word's occurrences, in the shape the search already uses.
 *
 * Reusing `editor__search-hit` is not laziness about styling - it is the same
 * object. A line number, the sentence with the word marked inside it, and a
 * click that takes you there is what a writer has already learned in this panel
 * from the search, and giving the same thing a second appearance would be a
 * second thing to learn for no gain.
 *
 * The chapter is on every line rather than in a per-chapter heading, which is
 * where this differs from the search. The search groups by chapter because the
 * question there is "where in the book is this phrase". Here the row has
 * already answered that - it carries a chapter count - and the question is "is
 * THIS use doing any work", which reads better as one flat list in book order.
 */
function fillAdverbInstances(details, row) {
    const list = details.querySelector('.editor__search-hits');
    if (!list) return;

    // `markQuote` wants context/contextOffset/quote/length, which is exactly
    // what the service puts on an occurrence - and its guard is what makes the
    // mark safe: if the offsets ever disagree with the text it returns the
    // sentence unmarked rather than marking the wrong word.
    list.innerHTML = row.occurrences.map((occ, i) => `
        <li>
            <button class="editor__search-hit" data-occ="${i}"
                title="${escapeHtml(occ.chapter)}${occ.verb ? ` - ${escapeHtml(occ.verb)} ${escapeHtml(row.word)}` : ''}">
                <span class="editor__search-line">${occ.line}</span>
                <span class="editor__search-text">${markQuote(occ)}</span>
            </button>
        </li>`).join('');

    if (row.truncated) {
        // The COUNT is exact and the list is not. Saying so is the difference
        // between a cap and a miscount, and the writer cannot tell by looking.
        const note = document.createElement('p');
        note.className = 'text-muted';
        note.textContent = `Showing the first ${row.occurrences.length} of ${row.total}.`;
        details.appendChild(note);
    }

    list.querySelectorAll('.editor__search-hit').forEach((btn) => {
        const occ = row.occurrences[Number(btn.dataset.occ)];
        btn.addEventListener('click', async () => {
            // Cross-chapter, exactly as the overuse report is, and with the
            // same trap: an offset is valid in every chapter, so applying one
            // to whatever happens to be open lands on the wrong sentence and
            // looks like it worked.
            if (occ.chapter !== doc.chapter) await openChapter(occ.chapter);

            // openChapter refuses when the buffer is dirty and the writer keeps
            // their changes, and it returns either way.
            if (occ.chapter !== doc.chapter) return;

            /*
             * Mark every use of the word in the chapter, not just this one.
             *
             * This is the other half of what the search does and the half that
             * actually changes the edit: an adverb is judged against its
             * neighbours, and seeing the four other "carefully"s on the same
             * page is what tells a writer which one to keep. Whole-word, or
             * "softly" lights up inside "softly-spoken".
             */
            surface.setHighlight(row.word, { wholeWord: true, caseSensitive: false });
            surface.setSelection(occ.offset, occ.offset + occ.quote.length);
            surface.focus();
        });
    });
}

/**
 * The finding's context with its own span marked, so a one-character finding
 * is readable. `contextOffset` is where the quote starts inside the context;
 * searching the context for the quote instead would mark the wrong comma
 * whenever the same fragment appears twice in the same sentence.
 */
function markQuote(finding) {
    const context = finding.context || finding.quote;
    const at = finding.contextOffset;

    if (!Number.isInteger(at) || at < 0 || at + finding.length > context.length
        || context.substr(at, finding.length) !== finding.quote) {
        return escapeHtml(context);
    }

    return escapeHtml(context.slice(0, at))
        + `<mark>${escapeHtml(finding.quote)}</mark>`
        + escapeHtml(context.slice(at + finding.length));
}

/**
 * Apply a mechanics fix.
 *
 * The guard is the one applySuggestion uses: an offset is only trustworthy
 * against the text that was scanned, and the writer may have kept typing.
 *
 * The shift afterwards is what makes the list usable rather than usable once.
 * A fix that is not the same length as the text it replaces moves everything
 * after it, so every later finding in the list would fail its own guard and
 * the writer would be told to rescan after every single fix. Moving the
 * remaining offsets by the delta keeps the rest of the list live, and findings
 * before the edit are untouched because nothing before it moved.
 */
function applyMechanics(finding, btn, list = []) {
    const text = surface.getValue();
    if (text.substr(finding.offset, finding.length) !== finding.quote) {
        btn.textContent = 'text moved — rescan';
        btn.disabled = true;
        return;
    }

    surface.setValue(
        text.slice(0, finding.offset) + finding.replacement + text.slice(finding.offset + finding.length),
        { keepHistory: true }
    );

    const delta = finding.replacement.length - finding.length;
    if (delta !== 0) {
        for (const other of list) {
            if (other !== finding && other.offset > finding.offset) other.offset += delta;
        }
    }
    // Applied, so it must not be applied again if the writer clicks twice.
    finding.length = finding.replacement.length;
    finding.quote = finding.replacement;

    btn.textContent = 'fixed';
    btn.disabled = true;
    updateCounts();
    markDirty();
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
    // These arrive minutes later, over the socket. The writer may well have
    // shut the drawer in the meantime, and results appearing into a hidden
    // panel would look like the scan silently failed.
    openDrawer('Line edits');
    document.getElementById('editorPending')?.remove();

    if (!payload.ok) {
        els.output.insertAdjacentHTML('beforeend',
            `<p class="text-danger">${escapeHtml(payload.message || 'Suggestion scan failed.')}</p>`);
        announce(0);
        return;
    }
    if (!payload.suggestions.length) {
        els.output.insertAdjacentHTML('beforeend', '<h4>Edits</h4><p class="text-muted">No edits proposed.</p>');
        announce(0);
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
    announce(payload.suggestions.length);

    els.output.querySelectorAll('.editor__apply').forEach(btn => {
        btn.addEventListener('click', () => applySuggestion(payload.suggestions[Number(btn.dataset.index)], btn));
    });
}

/**
 * Apply a line edit.
 *
 * FIND THE TEXT AGAIN RATHER THAN TRUSTING THE OFFSET.
 *
 * The recorded offset describes the document as it was SCANNED, and the first
 * edit applied invalidates it for every later one: a replacement that is not
 * the same length as what it replaced moves everything after it. The previous
 * version only checked the stored offset, so applying one edit made every
 * remaining button in the list report "text moved" and refuse — which read as
 * the feature being broken, because a list of ten edits could only ever apply
 * the one the writer happened to press first.
 *
 * Re-locating is safe HERE specifically because SuggestionService.verify
 * guarantees `original` occurs exactly once in the chapter — it drops anything
 * ambiguous before the writer ever sees it. That is not true of mechanics
 * findings, whose quote may be a single comma, which is why applyMechanics
 * shifts offsets instead of searching.
 *
 * The uniqueness is re-checked at apply time rather than assumed: the writer
 * may have typed a second copy of that sentence since the scan, and replacing
 * the wrong one would corrupt prose they never reviewed.
 */
function applySuggestion(s, btn) {
    const text = surface.getValue();

    // The recorded offset first - it is right in the common case and costs
    // nothing to check - then a search for the span itself.
    const at = text.substr(s.offset, s.length) === s.original
        ? s.offset
        : text.indexOf(s.original);

    const refuse = (message) => {
        btn.textContent = message;
        btn.disabled = true;
    };

    if (at === -1) return refuse('that line has changed — rescan');
    if (text.indexOf(s.original, at + s.original.length) !== -1) {
        // Ambiguous now, though it was unique when scanned.
        return refuse('appears more than once — rescan');
    }

    // Only the span, so Ctrl+Z takes back this edit rather than the chapter,
    // and the caret lands on the new words so the writer sees what happened.
    surface.replaceRange(at, at + s.original.length, s.replacement);

    btn.textContent = 'applied';
    btn.disabled = true;
    updateCounts();
    markDirty();
}

/**
 * Put the open chapter on disk before something reads it from there.
 *
 * `runSearch` and `runOveruse` have done `if (dirty) await save()` inline
 * since they were written, for one reason: every scan in this app reads the
 * FILE, not the buffer, so a scan of an unsaved chapter measures a version of
 * the prose the writer can see is out of date on screen.
 *
 * The narration export needs the same guarantee and cannot reach `save()` -
 * it lives in the rail, which is built once and never torn down, while this
 * section is rebuilt on navigation. Exported rather than duplicated, because
 * a second implementation of "save if dirty" is a second thing to get wrong.
 *
 * It matters more here than for a search. A stale search wastes a moment; a
 * stale export spends the daily allowance rendering a paragraph the writer
 * has already fixed, and the result sounds correct while being wrong.
 */
export async function saveIfDirty() {
    if (dirty) await save();
    return !dirty;
}

/* ---------- thesaurus ---------- */

/**
 * A plain line in the drawer.
 *
 * ReviewMenu has a note() of its own for its flyouts; this file writes into
 * els.output and had no equivalent, so the four messages below would otherwise
 * each have invented their own markup.
 *
 * Takes HTML rather than text, because every caller wants a word emphasised
 * inside the sentence. Callers escape what came from the manuscript.
 */
function drawerNote(html) {
    return `<p class="text-muted">${html}</p>`;
}

/*
   Datamuse, through the server. No key, no model, and it works with the AI
   switched off - the same class of tool as spelling and the mechanics scan.

   The word being looked up and WHERE IT WAS are captured together and held
   here, because a replacement applied to a stale offset lands in the wrong
   place silently. See applySynonym.
*/
let lookup = null;   // { word, from, to, sentence, results }

/**
 * The word under the selection, or under the caret if nothing is selected.
 *
 * Expanding from a bare caret matters more than it looks: a writer reaches for
 * this mid-sentence with the caret sitting in the word they are unhappy with,
 * and demanding they double-click first is a step that teaches them the
 * feature is fussy.
 */
function wordAtSelection() {
    if (!surface) return null;

    const text = surface.getValue();
    const range = surface.getSelection();
    let { from, to } = range;

    const isWord = (ch) => ch && /[\p{L}\p{N}'’-]/u.test(ch);

    if (from === to) {
        while (from > 0 && isWord(text[from - 1])) from -= 1;
        while (to < text.length && isWord(text[to])) to += 1;
    } else {
        // A selection that grabbed trailing space or punctuation is still a
        // word lookup; trim rather than refuse.
        while (from < to && !isWord(text[from])) from += 1;
        while (to > from && !isWord(text[to - 1])) to -= 1;
    }

    const word = text.slice(from, to);
    if (!word || /[\s]/.test(word)) return null;

    /*
     * The sentence it sits in, shown above the list. Choosing a word for a
     * LINE rather than off a list is the whole difference between this and the
     * thesaurus-diving that produces ridiculous prose.
     */
    let start = from;
    while (start > 0 && !/[.!?\n]/.test(text[start - 1])) start -= 1;
    let end = to;
    while (end < text.length && !/[.!?\n]/.test(text[end])) end += 1;

    return {
        word, from, to,
        sentence: text.slice(start, Math.min(end + 1, text.length)).trim(),
        offsetInSentence: from - start
    };
}

async function runThesaurus() {
    if (!surface) return;

    const found = wordAtSelection();
    if (!found) {
        openDrawer('Thesaurus');
        els.output.innerHTML = drawerNote('Put the caret in a word, or highlight one, and try again.');
        return;
    }

    lookup = { ...found, results: null };
    openDrawer('Thesaurus');
    els.output.innerHTML = drawerNote(`Looking up <strong>${escapeHtml(found.word)}</strong>...`);

    try {
        const query = new URLSearchParams({ word: found.word });
        const data = await (await fetch(`/api/proofing/thesaurus?${query}`)).json();
        if (!data.ok) throw new Error(data.message || 'The thesaurus did not answer.');

        lookup.results = data.results;
        drawThesaurus();
    } catch (err) {
        els.output.innerHTML = drawerNote(escapeHtml(err.message));
    }
}

function drawThesaurus() {
    if (!lookup || !els.output) return;

    if (!lookup.results.length) {
        els.output.innerHTML = drawerNote(`No synonyms for <strong>${escapeHtml(lookup.word)}</strong>.`);
        return;
    }

    /*
     * The sentence, with the word marked in it. This is the context that stops
     * the list being a shopping trip: the question is not "what else means
     * this" but "what belongs in THIS line".
     */
    const before = escapeHtml(lookup.sentence.slice(0, lookup.offsetInSentence));
    const word = escapeHtml(lookup.sentence.substr(lookup.offsetInSentence, lookup.word.length));
    const after = escapeHtml(lookup.sentence.slice(lookup.offsetInSentence + lookup.word.length));

    const context = `<p class="thesaurus__line">${before}<mark>${word}</mark>${after}</p>`;

    const rows = lookup.results.map((entry, index) => `
        <button type="button" class="thesaurus__word${entry.rare ? ' thesaurus__word--rare' : ''}"
            data-synonym="${index}"
            title="${entry.rare ? 'Uncommon — a reader will notice this word' : ''}${entry.baseForm ? ' Base form; the tense may need fixing.' : ''}">
            ${escapeHtml(entry.word)}${entry.baseForm ? '<span class="thesaurus__flag">~</span>' : ''}
        </button>`).join('');

    els.output.innerHTML = context
        + `<div class="thesaurus__words">${rows}</div>`
        + drawerNote('Common words first. Click one to replace.');

    els.output.querySelectorAll('[data-synonym]').forEach((button) => {
        button.addEventListener('click', () => applySynonym(Number(button.dataset.synonym)));
    });
}

/**
 * Swap the word, having first checked it is still there.
 *
 * The offsets were taken when the lookup ran, and the writer may have typed
 * anywhere in the chapter since. Applying them blind would replace whatever
 * now occupies that span - silently, in the wrong place, and in a way nothing
 * on screen would reveal. Verified against the text, exactly as
 * applySuggestion does for the model's edits.
 */
function applySynonym(index) {
    const entry = lookup?.results?.[index];
    if (!entry || !surface) return;

    const current = surface.getValue().slice(lookup.from, lookup.to);
    if (current !== lookup.word) {
        els.output.innerHTML = drawerNote(
            `That line has changed since this was looked up, so nothing was replaced. `
            + `Highlight <strong>${escapeHtml(lookup.word)}</strong> again.`);
        return;
    }

    // Case is the writer's, not the dictionary's: a word that opened a
    // sentence must still open it after the swap.
    const replacement = /^[A-Z]/.test(lookup.word)
        ? entry.word.charAt(0).toUpperCase() + entry.word.slice(1)
        : entry.word;

    surface.replaceRange(lookup.from, lookup.to, replacement);
    closeDrawer();
}
