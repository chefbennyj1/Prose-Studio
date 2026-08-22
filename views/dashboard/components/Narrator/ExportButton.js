// views/dashboard/components/Narrator/ExportButton.js

// The editor owns the buffer and the file; the export reads the file.
import { saveIfDirty } from '../Editor/Editor.js';

/**
 * Export narration.
 *
 * The one control in this app that spends money, so it behaves differently
 * from every other button in the rail:
 *
 *   - It asks FIRST, with a real number. The chapter is already on disk, so
 *     the character count and the paragraph count are known before a request
 *     is made. "Render?" with nothing attached would be a blind commitment.
 *   - It counts only what is NOT already rendered. Re-exporting after fixing a
 *     typo costs one paragraph, and the confirmation should say so rather than
 *     quoting the whole chapter again and frightening the writer off.
 *   - Running out of the daily free allowance is reported as PROGRESS, not
 *     failure. Everything rendered is kept and hashed; tomorrow's run resumes.
 *     Calling that an error would be a lie that costs the writer their nerve.
 *
 * The style prompt is the direction the voice acts to. It lives in
 * localStorage rather than the manifest because it belongs to the writer and
 * the story, not to one render - and it is part of the segment hash server
 * side, so changing it here really does produce a new reading.
 */

const STYLE_KEY = 'prose-engine-export-style';

/**
 * Ben's, tuned by ear over a real chapter. Every clause in it is load-bearing
 * and it should not be tidied up by anyone who has not listened to the result:
 *
 *   "do not give character speech an overly excited expression"
 *       The fix for the actual failure. An earlier direction asked for
 *       "dramatic", which the model applies to the WHOLE paragraph - dialogue
 *       included - and drama applied to a character's line does not read as
 *       intensity, it reads as whining. Narration and speech need different
 *       treatment and the prompt is the only place to say so.
 *
 *   "older, seductive, sensual, smooth, young, sexy"
 *       Contradictory on purpose, and not a description of a character. These
 *       pull the model's register without naming it; the mix is what produces
 *       smooth rather than any one of the words.
 *
 *   "smooth, not dramatic" / "not drawn out"
 *       Stated twice between them because the failure modes are opposite ends
 *       of the same dial: theatrical at one end, flat and slow at the other.
 *
 * Speed and volume are NOT here and cannot be: the API rejects speakingRate,
 * speed and audioConfig by name - speech_config takes a voice and nothing
 * else. The console's speed slider is client-side playback, not a render
 * setting, so a take tuned at 1.25x there is this audio played faster.
 */
const DEFAULT_STYLE =
    'smooth, not drawn out. do not give character speech an overly excited expression. '
    + 'older,  seductive, sensual, smooth, young, sexy, speaks the final syllables in speech '
    + 'specifically.  smooth, not dramatic.';

let els = {};
let doc = { story: null, chapter: null };
let busy = false;

export function initExportButton() {
    /*
     * ============================================================
     * PAUSED, 2026-08-18, at Ben's request.
     *
     * Two chapters came to $1.18 - well above the 6.7c-a-chapter figure
     * measured from one sample - because changing the style prompt makes every
     * paragraph stale and re-renders the lot. Until that is accounted for from
     * the manifests, this row must not be one stray click from spending again.
     *
     * Nothing is deleted. The routes, the service, the cached parts and the
     * rendered audio are all intact, so restoring costs nothing and re-renders
     * nothing.
     *
     * TO RESTORE: delete this return, and put `data-needs-ai` back on
     * #narratorExportBtn in dashboard.html (it is marked data-export-paused).
     * ============================================================
     */
    return;

    // eslint-disable-next-line no-unreachable
    els = {
        button: document.getElementById('narratorExportBtn'),
        hint: document.getElementById('narratorExportHint'),
        status: document.getElementById('narratorExportStatus'),
        preview: document.getElementById('narratorExportPreview'),
        audio: document.getElementById('narratorExportAudio'),
        previewNote: document.getElementById('narratorExportPreviewNote')
    };
    if (!els.button) return;

    els.button.addEventListener('click', onClick);

    /*
     * The editor owns what is open; the rail is told. `manuscriptOpened` is
     * the event it actually dispatches - the same one BackupButton, RailMenu
     * and the dictionary listen for. This module never reaches into the editor.
     */
    document.addEventListener('manuscriptOpened', (event) => {
        doc = { story: event.detail?.story || null, chapter: event.detail?.chapter || null };
        refresh();
    });

    listenForProgress();
    refresh();
}

/** The direction, as the writer last set it. */
export function exportStyle() {
    try {
        return localStorage.getItem(STYLE_KEY) || DEFAULT_STYLE;
    } catch {
        return DEFAULT_STYLE;
    }
}

export function setExportStyle(style) {
    try {
        localStorage.setItem(STYLE_KEY, String(style || '').trim() || DEFAULT_STYLE);
    } catch {
        // Private browsing. It still applies for this session.
    }
    refresh();
}

/**
 * Ask what it would cost, and put the answer on the row.
 *
 * Quiet on failure: this runs whenever a chapter is opened, and a writer who
 * has not switched the AI on does not need an error about a feature they are
 * not using. The row is hidden in that case anyway.
 */
async function refresh() {
    if (!els.button || !doc.story || !doc.chapter || busy) return;

    try {
        const query = new URLSearchParams({
            story: doc.story, chapter: doc.chapter, style: exportStyle()
        });
        const data = await (await fetch(`/api/narrator/export/plan?${query}`)).json();
        if (!data.ok) return;

        showPreview(data);

        if (!data.pending) {
            els.hint.textContent = data.total ? 'done' : 'nothing to say';
            return;
        }
        // Characters, because that is what the meter counts. Rounded to the
        // nearest thousand: a precise number here reads as a bill.
        const k = Math.max(1, Math.round(data.pendingCharacters / 1000));
        els.hint.textContent = `${data.pending} para, ~${k}k chars`;
    } catch {
        // Leave the hint as it was.
    }
}

/**
 * Offer the player once there is anything at all to hear.
 *
 * `preload="none"` and the src set only here, deliberately: the preview is
 * tens of megabytes and a browser told to preload would fetch it on every
 * chapter open, whether or not anyone intends to listen.
 *
 * The src carries the rendered count so it changes when more paragraphs land -
 * without it the browser would keep serving the version it already has, and
 * pressing play after a fresh render would replay the old, shorter take.
 */
function showPreview(plan) {
    if (!els.preview) return;

    /*
     * SAY SO WHEN THERE IS NOTHING, rather than showing nothing.
     *
     * The player used to just stay hidden here, and an absent player carries
     * exactly the same information as a broken one - Ben went hunting through
     * the console for a bug that was "you have a different chapter open". The
     * state has to be legible either way: here is the audio, or here is why
     * there isn't any.
     */
    if (!plan.cached) {
        els.audio.removeAttribute('src');
        els.audio.classList.add('hidden');
        els.previewNote.textContent = plan.total
            ? 'Nothing exported for this chapter yet.'
            : 'Nothing in this chapter to narrate.';
        els.preview.classList.remove('hidden');
        return;
    }

    els.audio.classList.remove('hidden');

    const query = new URLSearchParams({
        story: doc.story, chapter: doc.chapter, style: exportStyle(), n: String(plan.cached)
    });
    const next = `/api/narrator/export/preview?${query}`;

    // Never reassign mid-playback; it would stop the audio under the writer.
    if (els.audio.getAttribute('src') !== next && els.audio.paused) {
        els.audio.setAttribute('src', next);
    }

    els.previewNote.textContent = plan.pending
        ? `first ${plan.cached} of ${plan.total} paragraphs`
        : `all ${plan.total} paragraphs`;
    els.preview.classList.remove('hidden');
}

async function onClick() {
    if (busy || !doc.story || !doc.chapter) return;

    /*
     * SAVE FIRST. The export reads the chapter off DISK, so an unsaved edit is
     * invisible to it - and unlike a stale search, which wastes a moment, a
     * stale export spends the daily allowance synthesising a paragraph that has
     * already been fixed on screen. The result then sounds fine while being
     * wrong, which is the worst combination available.
     *
     * Failing to save is not a reason to refuse: the writer may have no story
     * folder set, and the render of what IS on disk is still worth having. It
     * is a reason to say so first.
     */
    try {
        await saveIfDirty();
    } catch (err) {
        say(`Could not save before exporting: ${err.message}`, true);
    }

    let plan;
    try {
        const query = new URLSearchParams({
            story: doc.story, chapter: doc.chapter, style: exportStyle()
        });
        plan = await (await fetch(`/api/narrator/export/plan?${query}`)).json();
    } catch (err) {
        return say(`Could not work out what this would cost: ${err.message}`, true);
    }

    if (!plan.ok) return say(plan.message || 'Could not plan the export.', true);
    if (!plan.available) return say(plan.reason || 'The AI is switched off.', true);
    if (!plan.total) return say('This chapter has nothing to narrate.');

    if (!plan.pending) {
        return say(`Already exported to export/${plan.folder}/. Nothing to render.`);
    }

    /*
     * The confirmation names the FOLDER as well as the cost, because "where
     * did it go" is the next question and the answer is not obvious - it is
     * not beside the chapter, it is in an export folder named by number.
     */
    const cached = plan.cached ? `\n${plan.cached} paragraph(s) are already rendered and cost nothing.` : '';
    const ok = window.confirm(
        `Export this chapter with the Gemini voice?\n\n`
        + `${plan.pending} paragraph(s) to render, about ${plan.pendingCharacters.toLocaleString()} characters.`
        + `${cached}\n\n`
        + `Goes to export/${plan.folder}/\n\n`
        + `If the daily free allowance runs out it will stop and keep what it has — `
        + `press again tomorrow and it carries on where it stopped.`
    );
    if (!ok) return;

    busy = true;
    els.button.disabled = true;
    say(`Rendering 0 of ${plan.total}...`);

    try {
        const response = await fetch('/api/narrator/export/render', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                story: doc.story, chapter: doc.chapter, style: exportStyle()
            })
        });
        const data = await response.json();

        if (!data.ok) {
            say(data.message || 'The export failed.', true);
        } else if (data.stopped === 'quota') {
            // Not an error. Say what is kept and what is left.
            say(`${data.stoppedMessage || 'Daily allowance reached.'} `
                + `${data.done} of ${data.total} done — press Export again tomorrow to carry on.`);
        } else if (data.complete) {
            say(`Done. export/${data.folder}/chapter.wav — ${formatClock(data.seconds)}.`);
        } else {
            say(`${data.done} of ${data.total} rendered. ${data.remaining} left.`);
        }
    } catch (err) {
        say(`The export failed: ${err.message}`, true);
    } finally {
        busy = false;
        els.button.disabled = false;
        refresh();
    }
}

/**
 * Progress over the socket rather than the response, because the response only
 * settles at the end and a chapter is minutes. The writer can close the menu;
 * nothing about the render lives in the browser.
 */
function listenForProgress() {
    const socket = window.socket || window.io?.();
    if (!socket) return;

    socket.on('export:progress', (event) => {
        if (event.story !== doc.story || event.chapter !== doc.chapter) return;
        say(`Rendering ${event.done} of ${event.total}${event.cached ? ' (cached)' : ''}...`);
    });
}

function say(message, isError = false) {
    if (!els.status) return;
    els.status.textContent = message;
    els.status.classList.remove('hidden');
    els.status.classList.toggle('text-error', !!isError);
}

/** 0:00 / 1:02:03, matching timestamps.txt. */
function formatClock(seconds) {
    if (!seconds) return '';
    const whole = Math.floor(seconds);
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    return h
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`;
}
