// views/dashboard/studio/js/SceneSession.js

/**
 * Tracks which piece of the manuscript is open in the editor, and restores it
 * across reloads.
 *
 * This replaces PageConfigManager, which did the same job for a comic page and
 * carried a great deal of panel-layout machinery with it — a layout browser, an
 * apply-layout button, and an orphaned-dialogue check that compared balloon
 * placements against the panels in the current template. None of that survives
 * contact with prose, so what is left is the part that was actually about
 * navigation: remember where the writer was, and say so in the breadcrumb.
 *
 * The volume/chapter/page vocabulary is kept for now because the underlying
 * scaffolding still speaks it. It becomes volume/chapter/scene when the atom
 * refactor lands, and this is the only module that has to care.
 */

const STORAGE_KEY = 'prose_last_active_scene';

let active = null;

export function getActiveScene() {
    return active;
}

export function setActiveScene(vol, chap, page, seriesId = null, seriesFolder = null) {
    if (!vol || !chap || !page) return;

    active = { vol, chap, page, seriesId, seriesFolder };
    window.EDITOR_SESSION = { ...window.EDITOR_SESSION, ...active };

    const display = document.getElementById('activePageDisplay');
    if (display) display.textContent = `${vol} / ${chap} / ${page}`;

    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(active));
    } catch (e) {
        // Private mode or a full quota; losing the breadcrumb is not fatal.
    }

    document.dispatchEvent(new CustomEvent('prose:scene-changed', { detail: active }));
}

export function restoreLastScene() {
    let saved;
    try {
        saved = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
        return;
    }
    if (!saved) return;

    try {
        const { vol, chap, page, seriesId, seriesFolder } = JSON.parse(saved);
        if (vol && chap && page) setActiveScene(vol, chap, page, seriesId, seriesFolder);
    } catch (e) {
        console.error('[SceneSession] Discarding unreadable saved scene.', e);
        try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    }
}
