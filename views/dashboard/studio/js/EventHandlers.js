import { updateUrlState } from './Navigation.js';
import { switchToSection, lastStudioSection } from './SectionRouter.js';
import {
    populateVolumeSelect,
    populateChapterSelect,
    populateEditPageSelect,
    showVolumesForSeries,
    showChaptersForVolume
} from './LibraryManager.js';
import { setActiveScene } from './SceneSession.js';

/**
 * The active-page breadcrumb doubles as the navigation trigger; the popover
 * holds the series/volume/chapter/page cascade that used to live in a sidebar.
 */
function toggleNavPopover(force) {
    const popover = document.getElementById('pageNavPopover');
    if (!popover) return;
    const show = force ?? popover.classList.contains('hidden');
    popover.classList.toggle('hidden', !show);
    document.getElementById('activePageCrumb')?.setAttribute('aria-expanded', String(show));
    // A populateSeriesSelect('editSeriesSelect') preload stood here, for a
    // cascade that no longer exists.
    //
    // NOTE: this whole function is unreachable. #pageNavPopover went with the
    // comic page cascade, so the guard on the first line returns every time -
    // as does the #activePageCrumb / #layoutEmptyPickBtn click handler that
    // calls it. Left in place because removing it means removing
    // loadSelectedPage() and its handlers too, which is a wider sweep than
    // this commit is doing.
}

function loadSelectedPage() {
    const vS = document.getElementById('editVolumeSelect');
    const cS = document.getElementById('editChapterSelect');
    const pS = document.getElementById('editPageSelect');
    const sS = document.getElementById('editSeriesSelect');

    const vol = vS?.options[vS.selectedIndex]?.getAttribute('data-folder');
    const seriesId = sS?.value;
    const seriesFolder = sS?.options[sS.selectedIndex]?.getAttribute('data-folder');
    const chapNum = cS?.options[cS.selectedIndex]?.getAttribute('data-number');
    const pageId = pS?.value;

    if (!vol || !chapNum || !pageId || !seriesId) return;

    const chap = 'chapter-' + chapNum;

    window.EDITOR_SESSION = {
        volume: vol,
        volumeId: vS.value,
        chapter: chap,
        chapterId: cS.value,
        pageId,
        seriesId,
        seriesFolder
    };

    setActiveScene(vol, chap, pageId, seriesId, seriesFolder);
    updateUrlState({ tab: 'editor', vol, chap, page: pageId, series: seriesId, seriesFolder });
    toggleNavPopover(false);
}

export function initEventHandlers(container, allSections) {
    // User Menu Toggle (Topbar)
    const userProfileToggle = document.getElementById('userProfileToggle');
    const userMenu = document.getElementById('userMenu');

    if (userProfileToggle && userMenu) {
        userProfileToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            userMenu.classList.toggle('show');
        });

        document.addEventListener('click', () => {
            userMenu.classList.remove('show');
        });
    }

    // Navigation popover closes on any click outside it (the empty-state
    // button is exempt: its own handler is the one opening it)
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.pb-context-nav') && !e.target.closest('#layoutEmptyPickBtn')) {
            toggleNavPopover(false);
        }
    });

    const accountSettingsBtn = document.getElementById('accountSettingsBtn');
    if (accountSettingsBtn) {
        accountSettingsBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            userMenu?.classList.remove('show');
            updateUrlState({ tab: 'user-settings' });
            await switchToSection('user-settings', container);
        });
    }

    // Global Event Delegation
    container.addEventListener('click', async (e) => {
        const target = e.target.closest('button, li, .glass-tab, .volume-card, .series-card, #accountSettingsBtn');
        if (!target) return;

        // Topbar Navigation ("Studio" resolves to the last rail section)
        if (target.classList.contains('glass-tab') && target.closest('#main-navigation')) {
            let page = target.dataset.page;
            if (!page) return;
            if (page === 'studio') page = lastStudioSection();
            updateUrlState({ tab: page });

            // Note: active state handled inside switchToSection for glass-tabs
            await switchToSection(page, container);
        }

        // Studio rail. "Create New" inside a rail menu navigates the same way
        // the old create-story / create-chapter buttons did, so it carries the
        // same data-target and reuses this path rather than a second one.
        const railBtn = target.closest('.studio-rail__btn, .rail-menu [data-target]');
        if (railBtn && railBtn.dataset.target) {
            updateUrlState({ tab: railBtn.dataset.target });
            await switchToSection(railBtn.dataset.target, container);
        }

        // Account Settings Link
        if (target.id === 'accountSettingsBtn') {
            e.preventDefault();
            updateUrlState({ tab: 'user-settings' });
            await switchToSection('user-settings', container);
        }

        // Active-page breadcrumb (and the Layout pane's empty state) opens navigation
        if (target.id === 'activePageCrumb' || target.id === 'layoutEmptyPickBtn') {
            toggleNavPopover();
        }

        // Library Cards
        if (target.closest('.series-card')) {
            const card = target.closest('.series-card');
            showVolumesForSeries(card.id);
        }
        if (target.closest('.volume-card')) {
            const card = target.closest('.volume-card');
            showChaptersForVolume(card.id);
        }
        // A chapter card used to deep-link into the comic viewer. There is no
        // viewer now; a chapter opens in the editor instead.
        const chapterCard = target.closest('.chapter-card');
        if (chapterCard) {
            updateUrlState({ tab: 'editor', vol: chapterCard.dataset.volumeId, chap: chapterCard.dataset.chapterNumber });
            await switchToSection('editor', container);
        }
    });

    // Input Change Events
    container.addEventListener('change', e => {
        if (e.target.id === 'globalSeriesSelect') {
            localStorage.setItem('globalSeries', e.target.value);
            localStorage.removeItem('globalVolumeId');
            localStorage.removeItem('globalVolumeFolder');
            populateVolumeSelect('globalVolumeSelect', e.target.value).then(() => {
                const sVol = document.getElementById('globalVolumeSelect');   
                if(sVol) sVol.value = '';
            });
        }
        if (e.target.id === 'globalVolumeSelect') {
            const option = e.target.options[e.target.selectedIndex];
            if (option && option.value) {
                localStorage.setItem('globalVolumeId', e.target.value);       
                localStorage.setItem('globalVolumeFolder', option.getAttribute('data-folder') || '');
            } else {
                localStorage.removeItem('globalVolumeId');
                localStorage.removeItem('globalVolumeFolder');
            }
        }
        // Series to Volume Filtering
        if (e.target.id === 'volumeSeriesSelect') populateVolumeSelect('volumeSelect', e.target.value);
        if (e.target.id === 'chapterSeriesSelect') populateVolumeSelect('chapterVolumeSelect', e.target.value);
        if (e.target.id === 'builderSeriesSelect') populateVolumeSelect('builderVolumeSelect', e.target.value);
        if (e.target.id === 'insertSeriesSelect') populateVolumeSelect('insertVolumeSelect', e.target.value);
        if (e.target.id === 'scriptSeriesSelect') populateVolumeSelect('scriptVolumeSelect', e.target.value);
        if (e.target.id === 'arrangeSeriesSelect') populateVolumeSelect('arrangeVolumeSelect', e.target.value);
        if (e.target.id === 'exportSeriesSelect') populateVolumeSelect('exportVolumeSelect', e.target.value);

        if (e.target.id === 'builderVolumeSelect') {
            const sId = document.getElementById('builderSeriesSelect').value;
            populateChapterSelect(e.target.value, 'builderChapterSelect', true, sId);
        }
        if (e.target.id === 'insertVolumeSelect') {
            const sId = document.getElementById('insertSeriesSelect').value;
            populateChapterSelect(e.target.value, 'insertChapterSelect', true, sId);
        }
        if (e.target.id === 'editChapterSelect') {
            populateEditPageSelect(document.getElementById('editVolumeSelect').value, e.target.value);
            // Sync session
            if (window.EDITOR_SESSION) window.EDITOR_SESSION.chapterId = e.target.value;
        }
        if (e.target.id === 'editPageSelect') {
            if (window.EDITOR_SESSION) window.EDITOR_SESSION.pageId = e.target.value;
            if (e.target.value && e.isTrusted) loadSelectedPage();
        }
        if (e.target.id === 'editVolumeSelect') {
            populateChapterSelect(e.target.value, 'editChapterSelect', false);
            // Sync session
            if (window.EDITOR_SESSION) {
                window.EDITOR_SESSION.volumeId = e.target.value;
                const opt = e.target.options[e.target.selectedIndex];
                window.EDITOR_SESSION.volume = opt?.getAttribute('data-folder');
            }
        }
        if (e.target.id === 'editSeriesSelect') {
            populateVolumeSelect('editVolumeSelect', e.target.value);
            // Sync session
            if (window.EDITOR_SESSION) {
                window.EDITOR_SESSION.seriesId = e.target.value;
                const opt = e.target.options[e.target.selectedIndex];
                window.EDITOR_SESSION.seriesFolder = opt?.getAttribute('data-folder');
            }
        }
    });
}
