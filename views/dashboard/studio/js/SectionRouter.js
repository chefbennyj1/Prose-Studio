// views/dashboard/studio/js/SectionRouter.js

/**
 * Section routing: lazy-loads dashboard section fragments, swaps visibility,
 * and keeps the studio rail highlight in sync. Sits below EventHandlers,
 * Navigation, and SceneEditor in the dependency graph so all three can route
 * without importing each other.
 */

// Fragment load cache — prevents duplicate fetches
const _loadedSections = new Set();

// Sections reachable from the persistent studio rail. A fresh entry resolves
// to the last one the writer used. The panel-art tools (layout editor, page
// builder, style lab, export) went with the comic stack; the editor takes
// their place as the landing section.
//
// The "studio" tab that used to resolve here was removed on 2026-08-23 - the
// rail does that job. `?tab=studio` is still honoured by Navigation.js and
// EventHandlers.js, because a bookmark or an old URL can still carry it.
export const STUDIO_SECTIONS = [
    'editor', 'characters', 'plot-lab', 'dictionary', 'word-cloud',
    'create-story', 'create-chapter', 'library-settings'
];

export function lastStudioSection() {
    const saved = localStorage.getItem('sequential_last_studio_section');
    return STUDIO_SECTIONS.includes(saved) ? saved : 'editor';
}

/**
 * Highlight the studio rail button for the visible section (clearing it for
 * non-rail sections) and remember rail sections as the landing default.
 */
function syncStudioRail(container, section) {
    container.querySelectorAll('#studioRail .studio-rail__btn').forEach(btn =>
        btn.classList.toggle('is-active', btn.dataset.target === section));
    if (STUDIO_SECTIONS.includes(section)) {
        localStorage.setItem('sequential_last_studio_section', section);
    }
}

/**
 * Switches the visible dashboard section and triggers any necessary data population.
 */
export async function switchToSection(targetPage, container) {
    console.log(`[Dashboard] Attempting switch to section: ${targetPage}`);

    const mountPoint = container.querySelector('#main-content');
    if (!mountPoint) {
        console.warn('[Dashboard] #main-content mount point not found.');
        return;
    }

    // --- Lazy-load fragment if not already in DOM ---
    if (!_loadedSections.has(targetPage)) {
        const fragmentUrl = `/views/dashboard/sections/${targetPage}/${targetPage}.html`;
        try {
            const res = await fetch(fragmentUrl);
            if (!res.ok) {
                console.warn(`[Dashboard] Fragment not found: ${fragmentUrl} (${res.status})`);
                return;
            }
            const html = await res.text();
            const temp = document.createElement('div');
            temp.innerHTML = html.trim();
            // Append ALL top-level nodes — fragments can have multiple sibling roots
            const docFrag = document.createDocumentFragment();
            while (temp.firstChild) docFrag.appendChild(temp.firstChild);
            mountPoint.appendChild(docFrag);
            _loadedSections.add(targetPage);
            console.log(`[Dashboard] Fragment loaded and mounted: ${targetPage}`);
            container.dispatchEvent(new CustomEvent('fragmentLoaded', { detail: { section: targetPage } }));
        } catch (err) {
            console.error(`[Dashboard] Failed to fetch fragment for '${targetPage}':`, err);
            return;
        }
    }

    // --- Existing visibility logic (UNCHANGED from original) ---
    const allSections = mountPoint.querySelectorAll('.dashboard-section, .glass-tab-panel');
    const targetSection = mountPoint.querySelector('.' + targetPage);

    if (!targetSection) {
        console.warn(`[Dashboard] Target section not found after fetch: .${targetPage}`);
        return;
    }

    const tabs = container.querySelectorAll('.glass-tab');
    tabs.forEach(tab => {
        const isActive = tab.dataset.page === targetPage;
        tab.setAttribute('aria-selected', String(isActive));
        tab.setAttribute('tabindex', isActive ? '0' : '-1');
    });

    allSections.forEach(s => {
        s.classList.remove('is-active');
        s.classList.add('hidden');
    });

    targetSection.classList.add('is-active');
    targetSection.classList.remove('hidden');

    // Sync the studio rail highlight the moment the section becomes visible —
    // before the (potentially slow) data populate below — so the active tool
    // never lags behind the click. Non-rail sections clear the highlight.
    syncStudioRail(container, targetPage);

    /*
     * NOTHING LEFT TO POPULATE HERE.
     *
     * Six lines stood here filling series dropdowns. Five targeted elements
     * that had not existed since the comic stack went - the worst being the
     * editor's, which fetched /library/series every time a writer opened a
     * chapter and handed the result to a querySelector that returned null.
     *
     * The last one filled the Character Lab's selector. The lab reads STORIES
     * now and loads them itself, so LibraryManager - the comic series cascade -
     * is no longer reached from this file at all.
     *
     * Kept as an empty array rather than deleted: this is where per-section
     * setup goes, and the next section to need some will want the seam.
     */
    const popTasks = [];

    await Promise.all(popTasks);

    // Dispatch completion event
    container.dispatchEvent(new CustomEvent('sectionShown', { detail: { section: targetPage } }));
}
