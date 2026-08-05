import { loadCSS } from '/libs/Utility.js';

/**
 * Fragment loader for the dashboard shell and the login page.
 *
 * This file used to be the comic reader's sliding-window preloader: it held
 * [previous, current, next] pages in memory and swapped panel art in and out,
 * because a comic page is megabytes of PNG. Prose is text — an entire novel is
 * a few hundred kilobytes — so the preloader had no reason to exist and went
 * with the viewer.
 *
 * What is left is the one piece the dashboard actually needed from it: fetch an
 * HTML fragment and mount it.
 */
export async function loadSection(containerId, htmlPath) {
    try {
        await loadCSS('/views/shared/styles/engine.css');

        const response = await fetch(htmlPath);

        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }

        const html = await response.text();
        const container = document.getElementById(containerId);
        if (!container) return;

        container.innerHTML = html;
        document.dispatchEvent(new CustomEvent('sectionLoaded', { detail: { id: containerId } }));
    } catch (err) {
        console.error(`Error loading section ${containerId}:`, err);
    }
}
