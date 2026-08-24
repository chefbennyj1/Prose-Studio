// views/dashboard/dashboard.js

import { getCurrentUser } from './studio/api/StudioClient.js';
import {
    registerNavigationHandlers,
    restoreStateFromUrl
} from './studio/js/Navigation.js';
import { populateSeriesSelect } from './studio/js/LibraryManager.js';
import { setActiveScene, restoreLastScene } from './studio/js/SceneSession.js';
import { initEditor } from './components/Editor/Editor.js';
import CharacterEditor from './components/CharacterLab/CharacterLab.js';
import { initPlotLab } from './components/PlotLab/PlotLab.js';
import { initAccounts } from './sections/accounts/accounts.js';
import { initUserSettings } from './sections/user-settings/user-settings.js';
import { initCreateStory, initCreateChapter } from './studio/js/StoryStructure.js';
import { initRailMenus } from './components/RailMenu/RailMenu.js';
import { initReviewMenu } from './components/RailMenu/ReviewMenu.js';
import { initBackupButton } from './components/RailMenu/BackupButton.js';
import { initNarratorMenu } from './components/Narrator/NarratorMenu.js';
import { initExportButton } from './components/Narrator/ExportButton.js';
import { initDictionary } from './sections/dictionary/dictionary.js';

// Imported Refactored Modules
import { initEventHandlers } from './studio/js/EventHandlers.js';
import { initFormHandlers } from './studio/js/FormHandlers.js';

export async function init(container) {
    console.log("Initializing Dashboard...");

    // Initialize WebSockets
    if (typeof io !== 'undefined') {
        window.socket = io();
        window.socket.on('connect', () => {
            console.log(`[WebSocket] Connected with ID: ${window.socket.id}`);
        });

        /*
           Say when the connection drops and when it comes back.

           Socket.io reconnects on its own and listeners survive it, so this
           changes no behaviour — it exists so that "the editor stopped
           noticing my file changes" can be diagnosed in one glance instead of
           guessed at. Live updates have two halves that can fail
           independently: this transport, and the filesystem watch behind it.
           Both now say so.
        */
        window.socket.on('disconnect', (reason) => {
            console.warn(`[WebSocket] Disconnected: ${reason}`);
        });
        window.socket.io.on('reconnect', (attempt) => {
            console.log(`[WebSocket] Reconnected after ${attempt} attempt(s).`);
        });

        window.socket.on('manuscript:watcher', ({ watching, root }) => {
            if (watching) console.log(`[Watcher] Live updates active on ${root}`);
            else console.warn('[Watcher] Live updates are NOT active - file changes will go unnoticed.');
        });


        window.socket.on('plugin_toast', (data) => {
            if (window.GlassToast) {
                window.GlassToast.show(data.type || 'info', data.title || 'Notification', data.message || '');
            }
        });

        // Pulse the topbar brain once whenever local proofing results land
        window.socket.on('proofing_suggestions', () => {
            const indicator = document.getElementById('dashboard-ai-indicator');
            if (!indicator) return;
            indicator.classList.remove('ai-pulse');
            void indicator.offsetWidth; // restart the animation if pulses overlap
            indicator.classList.add('ai-pulse');
        });
    } else {
        console.warn("[WebSocket] Socket.io client script not found.");
    }

    // Initialize Global Selects
    populateSeriesSelect('globalSeriesSelect').then(() => {
        const savedSeries = localStorage.getItem('globalSeries');
        if (savedSeries) {
            const sSel = document.getElementById('globalSeriesSelect');
            if (sSel) {
                sSel.value = savedSeries;
                // Dispatch change so globalVolumeSelect populates
                sSel.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
    });

    // The settings section no longer has a series dropdown to fill — its
    // per-series block was replaced by the story-folder picker.

    const allSections = container.querySelectorAll('.dashboard-section');

    // --- Register Navigation Handlers ---
    registerNavigationHandlers({
        setActiveScene
    });

    // --- Initialize Base Event Handlers ---
    initEventHandlers(container, allSections);

    // Story, Chapter and Narrator menus in the rail. Part of the shell, not a
    // lazily loaded section, so this runs once here rather than on
    // fragmentLoaded.
    //
    // Order matters: initRailMenus wires the open/close mechanics that the
    // Narrator and Review menus' flyoutOpened listeners depend on.
    initRailMenus();
    try { initNarratorMenu(); } catch (err) { console.error('[Dashboard] Narrator menu init failed', err); }
    try { initExportButton(); } catch (err) { console.error('[Dashboard] Export button init failed', err); }
    try { initReviewMenu(); } catch (err) { console.error('[Dashboard] Review menu init failed', err); }
    try { initBackupButton(); } catch (err) { console.error('[Dashboard] Backup button init failed', err); }

    // --- Lazy Initialize Sub-Systems when fragments load ---
    container.addEventListener('fragmentLoaded', (e) => {
        const section = e.detail.section;
        console.log(`[Dashboard] Initializing sub-system for: ${section}`);
        
        if (section === 'library-settings') {
            try { initFormHandlers(container); } catch (err) { console.error("FormHandlers init failed", err); }
        }
        if (section === 'create-story') {
            try { initCreateStory(); } catch (err) { console.error("Create Story init failed", err); }
        }
        if (section === 'create-chapter') {
            try { initCreateChapter(); } catch (err) { console.error("Create Chapter init failed", err); }
        }
        if (section === 'editor') {
             try { initEditor(container); } catch (err) { console.error("Editor init failed", err); }
        }
        if (section === 'characters') {
             try { new CharacterEditor(container); } catch (err) { console.error("CharacterEditor init failed", err); }
        }
        if (section === 'dictionary') {
             try { initDictionary(); } catch (err) { console.error('Dictionary init failed', err); }
        }
        if (section === 'plot-lab') {
             try { initPlotLab(container); } catch (err) { console.error("PlotLab init failed", err); }
        }
        if (section === 'accounts') {
             try { initAccounts(); } catch (err) { console.error("Accounts init failed", err); }
        }
        if (section === 'user-settings') {
             try { initUserSettings(); } catch (err) { console.error("UserSettings init failed", err); }
        }
    });

    // Inject Dictionary CSS
    if (!document.querySelector('link[href="/views/dashboard/sections/dictionary/dictionary.css"]')) {
        const dictCss = document.createElement('link');
        dictCss.rel = 'stylesheet';
        dictCss.href = '/views/dashboard/sections/dictionary/dictionary.css';
        document.head.appendChild(dictCss);
    }

    // Inject PlotLab CSS
    if (!document.querySelector(`link[href="/views/dashboard/components/PlotLab/PlotLab.css"]`)) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '/views/dashboard/components/PlotLab/PlotLab.css';
        document.head.appendChild(link);
    }

    // --- AI Status Indicator ---
    // The brain lights when the AI is switched on in Settings and has a key.
    // It used to report whether a local engine had loaded; there is no local
    // engine now, so what it answers is "will Critique and Line edits work".
    const updateAIIndicator = async () => {
        try {
            const res = await fetch('/api/proofing/status');
            if (!res.ok) return;
            const data = await res.json();
            const aiReady = !!(data.ok && data.suggestions?.ok);

            window.AI_CONFIG = { ai: aiReady };

            const indicator = document.getElementById('dashboard-ai-indicator');
            const svg = document.getElementById('dashboard-ai-brain-svg');
            if (!indicator || !svg) return;

            if (aiReady) {
                svg.style.fill = '#00ccff';
                svg.style.filter = 'drop-shadow(0 0 5px rgba(0,204,255,0.5))';
                indicator.title = 'AI: on. Critique and Line edits send text to Google.';
            } else {
                svg.style.fill = '#555';
                svg.style.filter = 'none';
                indicator.title = data.suggestions?.reason || 'AI: off. Spelling, mechanics and the narrator still work.';
            }
        } catch (e) {
            console.warn("[Dashboard] AI status check failed.");
        }
    };
    updateAIIndicator();

    // User & Data Load
    let user;
    try {
        user = await getCurrentUser();
    } catch (e) {
        window.location.href = "/login?returnTo=" +
            encodeURIComponent(window.location.pathname + window.location.search);
        return;
    }

    const userNameEl = document.getElementById('user-name');
    if (userNameEl) {
        userNameEl.textContent = user.username;

        if (window.GlassToast) {
            window.GlassToast.show('info', 'Welcome back, ' + user.username);
        }
    }

    if (user.avatar) {
        document.querySelectorAll('#userProfileToggle .avatar').forEach(el => {
            if (el.tagName === 'IMG') el.src = user.avatar;
        });
    }

    // --- Role-Based UI Filtering ---
    const role = user.role || 'basic';
    console.log(`[Dashboard] Initializing for role: ${role}`);

    // The presence heartbeat stood here. It kept a local LLM engine awake while
    // the dashboard was open and let it shut down once the beats stopped. There
    // is no local engine to keep awake now.

    // --- Server power controls (admin only) ---
    const restartBtn = document.getElementById('restartServerBtn');
    const shutdownBtn = document.getElementById('shutdownServerBtn');
    if (role === 'admin' && restartBtn && shutdownBtn) {
        restartBtn.classList.remove('hidden');
        shutdownBtn.classList.remove('hidden');

        restartBtn.onclick = async () => {
            const confirmed = await window.GlassConfirm.show('Restart Server',
                'The server will stop, then start fresh. The dashboard reloads when it is back.', 'Restart');
            if (!confirmed) return;
            await fetch('/api/system/restart', { method: 'POST' });
            if (window.GlassToast) window.GlassToast.show('info', 'Restarting', 'Waiting for the server to come back...', 0);
            // Give the old process time to exit before polling for the new one
            setTimeout(() => {
                const poll = setInterval(async () => {
                    try {
                        const res = await fetch('/api/test', { cache: 'no-store' });
                        if (res.ok) { clearInterval(poll); location.reload(); }
                    } catch (err) { /* still down; keep polling */ }
                }, 2000);
            }, 5000);
        };

        shutdownBtn.onclick = async () => {
            const confirmed = await window.GlassConfirm.show('Shut Down Server',
                'The server will stop. You will need to start it again manually.', 'Shut Down');
            if (!confirmed) return;
            await fetch('/api/system/shutdown', { method: 'POST' });
            if (window.GlassToast) window.GlassToast.show('info', 'Server stopped', 'You can close this tab.', 0);
        };
    }

    // --- Notification bell ---
    const myUserId = user._id || user.id;

    (async () => {
        try {
            const res = await fetch('/api/notifications');
            const data = await res.json();
            if (!data.ok) return;
            // glass_component.js loads via a plain script tag; wait for it briefly
            for (let i = 0; i < 10 && !window.GlassNotifications; i++) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            if (window.GlassNotifications) window.GlassNotifications.init(data.notifications);
        } catch (err) {
            console.warn('[Dashboard] Notification init failed:', err.message);
        }
    })();

    if (window.socket) {
        window.socket.on('notification', (n) => {
            if (n.user !== myUserId) return; // broadcast channel; keep only our own
            if (window.GlassNotifications) window.GlassNotifications.add(n);
        });
    }

    // Clicking a linked notification opens that scene in the editor
    document.addEventListener('glass:notification:select', (e) => {
        const link = e.detail.notification?.link;
        if (!link || !link.pageId) return;
        setActiveScene(link.volume, link.chapter, link.pageId, link.series || null, link.seriesFolder || null);
    });

    // Define restrictions. 'scheduled-tasks' left both lists with the comic
    // scanner; 'studio' and 'create-new-volume' name targets that no longer
    // exist either, and are kept only because hiding a target that is already
    // gone costs nothing and removing them is a separate question about roles.
    const moderatorHidden = ['user-settings', 'create-new-volume', 'create-new-chapter', 'accounts'];
    const basicHidden = ['studio', 'user-settings', 'accounts'];

    const hiddenTargets = role === 'admin' ? [] : (role === 'moderator' ? moderatorHidden : basicHidden);

    // Navigation items
    const navItems = container.querySelectorAll('.glass-tab');
    navItems.forEach(item => {
        if (hiddenTargets.includes(item.dataset.page)) {
            item.style.display = 'none';
        }
    });

    // Studio rail: basic users have no studio tools at all; others lose
    // the same targets their role hid on the old hub cards
    const studioRail = container.querySelector('#studioRail');
    if (studioRail && role === 'basic') {
        studioRail.style.display = 'none';
    } else if (studioRail) {
        studioRail.querySelectorAll('.studio-rail__btn').forEach(btn => {
            if (hiddenTargets.includes(btn.dataset.target)) {
                btn.style.display = 'none';
            }
        });
    }


    // Default view for basic users. The Studio tab that used to be
    // deselected here went on 2026-08-23; the rail is how sections are
    // reached now, and it is hidden outright for this role a few lines up.
    if (role === 'basic') {
        const settingsTab = container.querySelector('.glass-tab[data-page="library-settings"]');
        if (settingsTab) {
            settingsTab.setAttribute('aria-selected', 'true');
            settingsTab.classList.add('glass-nav__item--active');
        }

    }

    // Admins see everything (default state of dashboard.html)

    // Restore State
    await restoreStateFromUrl(container);
    restoreLastScene();
}
