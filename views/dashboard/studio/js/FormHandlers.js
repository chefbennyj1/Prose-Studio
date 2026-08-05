// views/dashboard/studio/js/FormHandlers.js

import { setActiveScene } from './SceneSession.js';
import { updateUrlState } from './Navigation.js';
import { fetchChapterRange } from '../api/StudioClient.js';

function updateStatus(statusEl, message, type = 'error') {
    if (!statusEl) return;
    statusEl.textContent = message;
    if (type === 'error') statusEl.className = "builder-status text-accent";
    else if (type === 'success') statusEl.className = "builder-status text-accent font-bold";
    else if (type === 'loading') statusEl.className = "builder-status text-muted";
}

function getSelectionData(prefix) {
    const volSelect = document.getElementById(`${prefix}VolumeSelect`);
    const vol = volSelect ? volSelect.value : null;
    const seriesId = volSelect ? volSelect.options[volSelect.selectedIndex]?.getAttribute('data-series-id') : null;
    const chapSelect = document.getElementById(`${prefix}ChapterSelect`);
    const chap = chapSelect ? chapSelect.value : null;
    return { vol, seriesId, chap };
}

function redirectAfterSuccess(vol, chap, pageId, seriesId) {
    setTimeout(() => {
        setActiveScene(vol, chap, pageId, seriesId);
        updateUrlState({ tab: 'editor', vol, chap, page: pageId, series: seriesId });
    }, 1000);
}

const apiPost = (url, bodyData) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyData)
});

async function saveSettings(url, settings, btn, successMsg) {
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Saving...";

    try {
        const res = await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings })
        });
        const data = await res.json();
        if (data.ok) {
            if (window.GlassToast) {
                window.GlassToast.show('success', 'Settings Saved', successMsg);
            }
        } else throw new Error(data.message);
    } catch (err) {
        console.error("Settings save failed", err);
        if (window.GlassToast) {
            window.GlassToast.show('error', 'Save Failed', err.message || "Request failed.");
        } else {
            alert("Error: " + (err.message || "Request failed."));
        }
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

async function handleApiFormSubmit(options) {
    const { 
        btn, 
        status, 
        loadingText = "Processing...", 
        loadingStatusText = "Processing...",
        originalBtnText, 
        fetchCall, 
        onSuccess,
        onFinally,
        successMsg = "Success!"
    } = options;

    if (btn) {
        btn.disabled = true;
        btn.textContent = loadingText;
    }
    updateStatus(status, loadingStatusText, 'loading');

    try {
        const res = await fetchCall();
        const data = await res.json();

        if (data.ok) {
            updateStatus(status, successMsg, 'success');
            if (onSuccess) await onSuccess(data);
        } else {
            updateStatus(status, "Error: " + data.message, 'error');
        }
    } catch (err) {
        console.error(err);
        updateStatus(status, "Request Failed.", 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = originalBtnText;
        }
        if (onFinally) onFinally();
    }
}


export function initFormHandlers(container) {
    // Page Builder Form Submission (Create Page)
    const createPageForm = document.getElementById('page-builder-form');      
    if (createPageForm) {
        createPageForm.onsubmit = async (e) => {
            e.preventDefault();
            const btn = document.getElementById('createPageBtn');
            const status = document.getElementById('builderStatus');

            const { vol, seriesId, chap } = getSelectionData('builder');
            const pageId = document.getElementById('builderPageId').value;    
            const layout = document.getElementById('builderLayoutSelect').value;

            if (!vol || !chap || !pageId || !layout) {
                status.textContent = "Please fill all fields.";
                status.className = "builder-status text-accent";
                return;
            }

            await handleApiFormSubmit({
                btn,
                status,
                loadingText: "Creating...",
                loadingStatusText: "Processing...",
                originalBtnText: "Create Page Structure",
                successMsg: "Success! Page created. Syncing...",
                fetchCall: () => apiPost('/api/editor/create-page', { series: seriesId, volume: vol, chapter: chap, pageId, layout }),
                onSuccess: () => redirectAfterSuccess(vol, chap, pageId, seriesId)
            });
        };
    }

    // Next Consecutive Button Logic
    const getNextPageIdBtn = document.getElementById('getNextPageIdBtn');
    if (getNextPageIdBtn) {
        getNextPageIdBtn.onclick = async () => {
            const { vol, seriesId, chap } = getSelectionData('builder');
            const pageInput = document.getElementById('builderPageId');
            const status = document.getElementById('builderStatus');

            if (!vol || !chap) {
                status.textContent = "Please select Volume and Chapter first.";
                status.className = "builder-status text-accent";
                return;
            }

            await handleApiFormSubmit({
                btn: getNextPageIdBtn,
                status,
                loadingText: "...",
                loadingStatusText: "Determining next page...",
                originalBtnText: originalText,
                successMsg: "Next consecutive page ID determined.",
                fetchCall: () => fetch(`/api/editor/next-page-id?series=${seriesId}&volume=${vol}&chapter=${chap}`),
                onSuccess: (data) => {
                    pageInput.value = data.nextPageId;

                    // Page numbers run continuously across the volume, so the
                    // slot after this chapter's last page belongs to the next
                    // chapter unless this is the final one. Create Page cannot
                    // make room -- only Insert Page shifts the later chapters.
                    if (data.available === false) {
                        updateStatus(status,
                            `${data.nextPageId} already exists in ${data.ownedBy}. ` +
                            `Use Insert Page at index ${data.insertPoint} instead — it shifts ${data.ownedBy} ` +
                            `and every later chapter to make room.`,
                            'error');
                    }
                }
            });
        };
    }

    // Insert Page Form Submission
    const insertPageForm = document.getElementById('insert-page-form');       
    if (insertPageForm) {
        insertPageForm.onsubmit = async (e) => {
            e.preventDefault();
            const btn = document.getElementById('insertPageBtn');
            const status = document.getElementById('insertStatus');

            const { vol, seriesId, chap } = getSelectionData('insert');
            const insertPointStr = document.getElementById('insertPoint').value; 
            const insertPoint = parseInt(insertPointStr);

            if (!vol || !chap || isNaN(insertPoint)) {
                status.textContent = "Please fill all fields.";
                status.className = "builder-status text-accent";
                return;
            }

            // Chapter Range Validation
            status.textContent = "Validating chapter range...";
            const range = await fetchChapterRange(seriesId, vol, chap);
            if (range && range.count > 0) {
                if (insertPoint < range.min || insertPoint > (range.max + 1)) {
                    const confirmMsg = `WARNING: The selected chapter (${chap}) typically contains pages ${range.min} to ${range.max}.\n\n` +
                                     `You are attempting to insert page ${insertPoint}.\n\n` +
                                     `This may cause structural issues if this chapter isn't the correct place for that index.\n\n` +
                                     `Are you sure you want to proceed?`;
                    if (!confirm(confirmMsg)) {
                        status.textContent = "Operation cancelled by user.";
                        return;
                    }
                }
            }

            await handleApiFormSubmit({
                btn,
                status,
                loadingText: "Processing...",
                loadingStatusText: "Shifting folders and re-naming files...",
                originalBtnText: "Insert & Shift Pages",
                successMsg: "Success! Pages shifted and new page inserted.",
                fetchCall: () => apiPost('/api/editor/insert-page', { series: seriesId, volume: vol, chapter: chap, insertPoint }),
                onSuccess: () => {
                    const newPageId = 'page' + insertPoint;
                    setActiveScene(vol, chap, newPageId, seriesId);
                    updateUrlState({ tab: 'page-builder', vol, chap, page: newPageId, series: seriesId });
                }
            });
        };
    }

    // Create Volume Form Submission
    const createVolumeForm = document.getElementById('volume-info');
    if (createVolumeForm) {
        createVolumeForm.onsubmit = async (e) => {
            e.preventDefault();
            const btn = document.getElementById('createVolumeBtn');
            const status = document.getElementById('volumeStatus');
            const overlay = document.getElementById('savingOverlay');

            const seriesId = document.getElementById('createVolumeSeriesSelect').value;
            const index = document.getElementById('index').value;
            const title = document.getElementById('title').value;
            const firstChapterTitle = document.getElementById('firstChapterTitle').value;

            if (!seriesId || !index || !title || !firstChapterTitle) {
                status.textContent = "Please fill all fields.";
                status.className = "builder-status text-accent";
                return;
            }

            if (overlay) overlay.classList.add('active');
            await handleApiFormSubmit({
                btn,
                status,
                loadingText: "Creating...",
                loadingStatusText: "Processing...",
                originalBtnText: "Create Volume Structure",
                successMsg: "Success! Volume created. Redirecting...",
                fetchCall: () => apiPost('/api/volume/create', { seriesId, index, title, firstChapterTitle }),
                onSuccess: () => {
                    setTimeout(() => {
                        window.location.reload(); // Reload to refresh the library
                    }, 1500);
                },
                onFinally: () => {
                    if (overlay) overlay.classList.remove('active');
                }
            });
        };
    }

    // Create Chapter Form Submission
    const createChapterForm = document.getElementById('chapter-info');        
    if (createChapterForm) {
        createChapterForm.onsubmit = async (e) => {
            e.preventDefault();
            const btn = document.getElementById('createChapterBtn');
            const status = document.getElementById('chapterStatus');

            const { vol, seriesId } = getSelectionData('chapter');
            const chapterIndex = document.getElementById('chapterIndex').value;
            const title = document.getElementById('chapterTitle').value;      

            if (!vol || !chapterIndex) {
                status.textContent = "Please select a volume and enter a chapter index.";
                status.className = "builder-status text-accent";
                return;
            }

            await handleApiFormSubmit({
                btn,
                status,
                loadingText: "Initializing...",
                loadingStatusText: "Checking for existence and creating chapter...",
                originalBtnText: "Initialize Chapter",
                successMsg: "Success! Chapter created. Syncing database...",
                fetchCall: () => apiPost('/api/editor/create-chapter', { series: seriesId, volume: vol, chapterIndex, title }),
                onSuccess: (data) => {
                    updateStatus(status, "Success! " + data.message + ". Syncing database...", 'success');
                    redirectAfterSuccess(vol, data.chapter, data.pageId, seriesId);
                }
            });
        };
    }

    // Insert Chapter (shifts the target chapter and everything after it up by
    // one, plus every page inside all of them) — same fields as Create Chapter,
    // different endpoint, so it's a plain button rather than the form's submit.
    const insertChapterBtn = document.getElementById('insertChapterBtn');
    if (insertChapterBtn) {
        insertChapterBtn.onclick = async () => {
            const status = document.getElementById('chapterStatus');
            const { vol, seriesId } = getSelectionData('chapter');
            const chapterIndex = document.getElementById('chapterIndex').value;
            const title = document.getElementById('chapterTitle').value;

            if (!vol || !chapterIndex) {
                status.textContent = "Please select a volume and enter a chapter index.";
                status.className = "builder-status text-accent";
                return;
            }

            const confirmed = window.GlassConfirm
                ? await window.GlassConfirm.show('Insert Chapter', `This will shift chapter ${chapterIndex} and everything after it (chapters and pages) up by one. Continue?`, 'Insert')
                : confirm(`This will shift chapter ${chapterIndex} and everything after it up by one. Continue?`);
            if (!confirmed) return;

            await handleApiFormSubmit({
                btn: insertChapterBtn,
                status,
                loadingText: "Shifting...",
                loadingStatusText: "Shifting chapters and pages, this may take a moment...",
                originalBtnText: "Insert & Shift Chapters",
                successMsg: "Success! Chapters shifted and new chapter inserted.",
                fetchCall: () => apiPost('/api/editor/insert-chapter', { series: seriesId, volume: vol, chapterIndex, title }),
                onSuccess: (data) => {
                    updateStatus(status, "Success! " + data.message + ". Syncing database...", 'success');
                    redirectAfterSuccess(vol, data.chapter, data.pageId, seriesId);
                }
            });
        };
    }

    // Story Library — where writing is saved on disk
    initStoryStorage();

    // Global Settings Form Submission
    initGlobalSettings();
}

async function initGlobalSettings() {
    const form = document.getElementById('global-settings-form');
    if (!form) return;

    // Gemini is the cloud critic now, not a panel-image describer. The old
    // vision-only fields (system prompt, max tokens, temperature, auto-scan on
    // save) went with the comic stack — nothing read them.
    const criticEnabled = document.getElementById('global-critic-enabled');
    const fieldsContainer = document.getElementById('critic-settings-fields');
    const apiKeyInput = document.getElementById('global-api-key');
    const modelNameSelect = document.getElementById('global-model-name');

    const toggleFields = () => {
        if (fieldsContainer && criticEnabled) {
            fieldsContainer.hidden = !criticEnabled.checked;
        }
    };
    if (criticEnabled) criticEnabled.onchange = toggleFields;

    // Load initial data
    try {
        const res = await fetch('/api/settings/global');
        const data = await res.json();
        if (data.ok && data.settings) {
            const c = data.settings.critic || {};
            if (criticEnabled) criticEnabled.checked = c.enabled || false;
            if (apiKeyInput) apiKeyInput.value = c.apiKey || '';
            if (modelNameSelect) modelNameSelect.value = c.modelName || 'gemini-flash-latest';
            toggleFields();
        }
    } catch (err) {
        console.error("Failed to load global settings", err);
    }

    form.onsubmit = async (e) => {
        e.preventDefault();
        const settings = {
            critic: {
                enabled: criticEnabled ? criticEnabled.checked : false,
                apiKey: apiKeyInput ? apiKeyInput.value : '',
                modelName: modelNameSelect ? modelNameSelect.value : 'gemini-flash-latest'
            }
        };

        const btn = document.getElementById('saveGlobalSettingsBtn');
        if (!btn) return;
        await saveSettings('/api/settings/global', settings, btn, 'Gemini critic settings updated.');
    };
}

/**
 * Story Library settings: choose the parent folder everything is saved into.
 *
 * Replaced the old per-series configuration block, which was a series dropdown
 * bound to a form with no fields left in it — the styling options it once
 * carried went with the comic stack.
 */
function initStoryStorage() {
    const pathInput = document.getElementById('storyRootPath');
    const status    = document.getElementById('storyRootStatus');
    const browseBtn = document.getElementById('browseStoryRootBtn');
    if (!pathInput || !browseBtn) return;

    const browser    = document.getElementById('folderBrowser');
    const list       = document.getElementById('folderList');
    const currentEl  = document.getElementById('folderCurrentPath');
    const upBtn      = document.getElementById('folderUpBtn');
    const errorEl    = document.getElementById('folderBrowserError');
    const newName    = document.getElementById('folderNewName');
    const newBtn     = document.getElementById('folderNewBtn');
    const cancelBtn  = document.getElementById('folderCancelBtn');
    const selectBtn  = document.getElementById('folderSelectBtn');

    // '' is the drive list, which is a real location in the browser but not a
    // folder you can save into — hence selectBtn being disabled there.
    let currentPath = '';
    let parentPath = null;

    const setStatus = (message, isError) => {
        status.textContent = message || '';
        status.classList.toggle('text-error', Boolean(isError));
    };

    const showError = (message) => {
        errorEl.textContent = message || '';
        errorEl.hidden = !message;
    };

    async function loadRoot() {
        try {
            const res = await fetch('/api/storage/root');
            const data = await res.json();
            if (!data.ok) return;

            pathInput.value = data.root || '';
            setStatus(data.configured
                ? 'Stories are saved here.'
                : 'Choose a folder before writing — the editor cannot save without one.',
                !data.configured);
        } catch (err) {
            setStatus('Could not read the current setting.', true);
        }
    }

    async function browseTo(target) {
        showError('');
        try {
            const res = await fetch(`/api/storage/browse?path=${encodeURIComponent(target || '')}`);
            const data = await res.json();
            if (!data.ok) {
                showError(data.message);
                return;
            }

            currentPath = data.path;
            parentPath = data.parent;

            currentEl.textContent = data.isRoot ? 'This PC' : data.path;
            upBtn.disabled = data.isRoot;
            selectBtn.disabled = data.isRoot;
            newBtn.disabled = data.isRoot;

            list.innerHTML = '';
            if (!data.entries.length) {
                const li = document.createElement('li');
                li.className = 'folder-browser__empty';
                li.textContent = data.isRoot ? 'No drives found.' : 'No sub-folders here. You can still save this one.';
                list.appendChild(li);
                return;
            }

            for (const entry of data.entries) {
                const li = document.createElement('li');
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'folder-browser__item';
                btn.innerHTML = '<ion-icon name="folder-outline"></ion-icon>';
                btn.appendChild(document.createTextNode(entry.name));
                btn.addEventListener('click', () => browseTo(entry.path));
                li.appendChild(btn);
                list.appendChild(li);
            }
            list.scrollTop = 0;
        } catch (err) {
            showError('Could not reach the server.');
        }
    }

    browseBtn.addEventListener('click', () => {
        browser.hidden = false;
        // Reopen where the current root lives, so changing it is a short trip.
        browseTo(pathInput.value || '');
    });

    const close = () => { browser.hidden = true; showError(''); newName.value = ''; };
    cancelBtn.addEventListener('click', close);
    browser.addEventListener('click', (e) => { if (e.target === browser) close(); });

    upBtn.addEventListener('click', () => browseTo(parentPath || ''));

    newBtn.addEventListener('click', async () => {
        const name = newName.value.trim();
        if (!name) return showError('Give the folder a name first.');

        newBtn.disabled = true;
        try {
            const res = await fetch('/api/storage/folder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ parent: currentPath, name })
            });
            const data = await res.json();
            if (!data.ok) return showError(data.message);

            newName.value = '';
            await browseTo(data.path); // step into what was just made
        } catch (err) {
            showError('Could not create the folder.');
        } finally {
            newBtn.disabled = false;
        }
    });

    selectBtn.addEventListener('click', async () => {
        selectBtn.disabled = true;
        try {
            const res = await fetch('/api/storage/root', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: currentPath })
            });
            const data = await res.json();
            if (!data.ok) {
                showError(data.message);
                return;
            }

            pathInput.value = data.root;
            setStatus(data.message);
            close();

            // The editor caches its story list; tell it the ground moved.
            document.dispatchEvent(new CustomEvent('storyRootChanged', { detail: { root: data.root } }));
        } catch (err) {
            showError('Could not save that folder.');
        } finally {
            selectBtn.disabled = false;
        }
    });

    loadRoot();
}
