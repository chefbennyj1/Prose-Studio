// views/dashboard/js/Navigation.js

import { switchToSection, lastStudioSection } from './SectionRouter.js';

// Deep-link targets live above this module in the dependency graph
// (SceneEditor, PageConfigManager), so they register themselves here at
// startup instead of being imported — see dashboard.js.
let _handlers = {};

export function registerNavigationHandlers(handlers) {
    _handlers = { ..._handlers, ...handlers };
}

export function updateUrlState(params) {
    const url = new URL(window.location);
    url.search = '';
    Object.keys(params).forEach(key => {
        if (params[key]) url.searchParams.set(key, params[key]);
    });
    window.history.pushState({}, '', url);
}

export async function restoreStateFromUrl(container) {
    const params = new URLSearchParams(window.location.search);
    let tab = params.get('tab');
    const vol = params.get('vol');
    const chap = params.get('chap');
    const page = params.get('page');
    const series = params.get('series');
    const seriesFolder = params.get('seriesFolder');

    // If no tab in URL, check for the active item in the navigation (default state)
    if (!tab) {
        const activeItem = container.querySelector('.glass-nav__item--active');
        if (activeItem) tab = activeItem.dataset.page;
    }

    // The hub is gone: fresh entries and legacy ?tab=studio URLs open the
    // last rail section the writer worked in
    if (!tab || tab === 'studio') tab = lastStudioSection();

    if (tab) {
        const item = container.querySelector(`.glass-tab[data-page="${tab}"]`);

        if (item) {
            // Update active state in UI to match current tab
            const nav = item.closest('#main-navigation');
            if (nav) {
                nav.querySelectorAll('.glass-tab').forEach(i => i.classList.remove('glass-nav__item--active'));
                item.classList.add('glass-nav__item--active');
            }
        }

        // Use the centralized switcher (Async/Event-Driven)
        await switchToSection(tab, container);

        // --- Deep Link State Restoration ---
        if (vol && chap && page) {
            console.log(`[Navigation] Deep-linking into: ${tab} (${vol}/${chap}/${page})`);

            // Dispatch to registered handlers immediately (The UI is now ready)
            if (tab === 'editor' && _handlers.setActiveScene) {
                _handlers.setActiveScene(vol, chap, page, series, seriesFolder);
            }
        }
    }
}
