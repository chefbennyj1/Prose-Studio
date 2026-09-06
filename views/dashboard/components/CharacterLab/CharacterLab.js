// views/dashboard/components/CharacterLab/CharacterLab.js
import { fetchCharactersAPI } from '../../studio/api/StudioClient.js';

/**
 * Which story the editor has open, read from its own record.
 *
 * The same trick the word cloud needs: this section mounts lazily, so
 * manuscriptOpened has already fired by the time it exists and cannot be
 * waited for.
 */
const LAST_PLACE_KEY = 'prose_engine_last_place';

function lastOpenStory() {
    try {
        const saved = JSON.parse(localStorage.getItem(LAST_PLACE_KEY) || 'null');
        return saved && saved.story ? saved.story : null;
    } catch {
        return null;
    }
}

export default class CharacterLab {
    constructor(container) {
        try {
            this.container = container;
            if (!container) return; // Guard clause

            this.listContainer = container.querySelector('#character-list');
            this.formContainer = container.querySelector('#character-form-container');
            this.createBtn = container.querySelector('#create-character-btn');
            // Named seriesSelect throughout for now; it holds a STORY name.
            this.seriesSelect = container.querySelector('#char-story-select');
            this.activeCharacterId = null;
            this.activeSeriesId = null;

            this.init();
        } catch (err) {
            console.error("[CharacterLab] Constructor failed:", err);
        }
    }

    async init() {
        console.log("[CharacterLab] Initializing...");
        if (!this.seriesSelect) {
            console.warn("[CharacterLab] Missing #char-story-select. Initialization aborted.");
            return;
        }

        /*
         * STORIES, not series.
         *
         * This asked /library/series for a list that only the comic library
         * scanner ever populated, so in a prose app it came back empty every
         * time - the dropdown had nothing in it, "+ New" stayed disabled, and
         * nothing anywhere said why. The lab has been dead since the comic
         * conversion for exactly this reason.
         */
        try {
            const response = await (await fetch('/api/manuscript/stories')).json();
            const stories = response.stories || [];

            this.seriesSelect.innerHTML = stories.length
                ? '<option value="">Select a story</option>'
                : '<option value="">No stories yet</option>';

            for (const entry of stories) {
                const name = entry.name || entry;
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                this.seriesSelect.appendChild(opt);
            }

            /*
             * Preselect whatever the editor has open. A writer who arrives here
             * from a chapter is thinking about that book's cast, and making
             * them pick it again from a list of one is a step for nothing.
             */
            const open = lastOpenStory();
            if (open && stories.some(e => (e.name || e) === open)) {
                this.seriesSelect.value = open;
                this.activeSeriesId = open;
                if (this.createBtn) this.createBtn.disabled = false;
                this.loadCharacters();
            }
        } catch (e) {
            console.error("[CharacterLab] Failed to load stories:", e);
            this.seriesSelect.innerHTML = '<option value="">Could not read your stories</option>';
        }

        this.seriesSelect.onchange = (e) => {
            this.activeSeriesId = e.target.value;
            if (this.createBtn) this.createBtn.disabled = !this.activeSeriesId;
            if (this.activeSeriesId) this.loadCharacters();
            else if (this.listContainer) this.listContainer.innerHTML = '';
        };

        if (this.createBtn) {
            this.createBtn.onclick = () => this.showForm();
        }

        const saveBtn = document.getElementById('save-character-btn');
        if (saveBtn) saveBtn.onclick = () => this.saveCharacter();

        const cancelBtn = document.getElementById('cancel-character-btn');
        if (cancelBtn) cancelBtn.onclick = () => this.hideForm();

        // Handle Avatar Upload
        const avatarInput = document.getElementById('char-avatar-input');
        if (avatarInput) {
            const avatarLabel = avatarInput.closest('label');
            if (avatarLabel) {
                avatarLabel.addEventListener('click', (e) => {
                    if (!this.activeCharacterId) {
                        e.preventDefault();
                        alert("Please Save the Record first before uploading a photo. We need an active profile to attach the image to!");
                    }
                }, true); // Capture phase to ensure we intercept before file picker
            }
            avatarInput.onchange = (e) => this.handleAvatarUpload(e);
        }

        // Handle AI Scan Profile
        this.aiScanBtn = document.getElementById('ai-analyze-char-btn');
        if (this.aiScanBtn) {
            this.aiScanBtn.onclick = () => this.handleAIScan();
        }

        // Handle Reference Upload
        const refInput = document.getElementById('char-reference-input');
        if (refInput) {
            const refLabel = refInput.closest('label');
            if (refLabel) {
                refLabel.addEventListener('click', (e) => {
                    if (!this.activeCharacterId) {
                        e.preventDefault();
                        alert("Please Save the Record first before adding reference images. We need an active profile to attach the files to!");
                    }
                }, true);
            }
            refInput.onchange = (e) => this.handleReferenceUpload(e);
        }
    }

    async loadCharacters() {
        this.listContainer.innerHTML = '<div class="text-muted">Loading subjects...</div>';
        try {
            const res = await fetch(`/api/characters?story=${encodeURIComponent(this.activeSeriesId)}`);
            const data = await res.json();
            if (data.ok) {
                this.renderList(data.characters);
            } else {
                throw new Error(data.message);
            }
        } catch (e) {
            this.listContainer.innerHTML = `<div class="text-accent">Failed to load dossier: ${e.message}</div>`;
        }
    }

    renderList(chars) {
        this.listContainer.innerHTML = '';
        if (!chars || chars.length === 0) {
            this.listContainer.innerHTML = '<div class="text-muted padding-20 italic">No characters found for this series.</div>';
            return;
        }
        chars.forEach(char => {
            const card = document.createElement('div');
            card.className = 'char-card glass glass--bright glass-card';
            card.innerHTML = `
                <img src="${char.image || '/views/public/images/avatar.png'}" class="char-avatar" style="border-color: white">
                <div class="char-info">
                    <span class="char-name">${char.name}</span>
                    <span class="char-desc">${char.description || 'No description'}</span>
                </div>
            `;
            card.onclick = () => this.showForm(char);
            this.listContainer.appendChild(card);
        });
    }

    showForm(character = null) {
        this.container.classList.add('editing');
        this.formContainer.classList.remove('hidden');
        this.listContainer.classList.add('hidden');
        this.createBtn.classList.add('hidden');

        const refGrid = document.getElementById('char-references-grid');
        refGrid.innerHTML = ''; // Clear references

        if (character) {
            this.activeCharacterId = character._id;
            document.getElementById('char-name').value = character.name;
            document.getElementById('char-description').value = character.description || '';
            if(document.getElementById('char-dialogue-style')) document.getElementById('char-dialogue-style').value = character.dialogueStylePrompt || '';
            document.getElementById('char-avatar-preview').src = character.image || '/views/public/images/avatar.png';
            document.getElementById('form-title').innerText = 'EDIT RECORD: ' + character.name;

            // Enable uploads
            this.setUploadsState(true);

            // Enable AI Scan if image exists
            this.aiScanBtn.disabled = !character.image;

            // Render References
            if (character.referenceImages && character.referenceImages.length > 0) {
                this.renderReferences(character.referenceImages);
            }

        } else {
            this.activeCharacterId = null;
            document.getElementById('char-name').value = '';
            document.getElementById('char-description').value = '';
            if(document.getElementById('char-dialogue-style')) document.getElementById('char-dialogue-style').value = '';
            document.getElementById('char-avatar-preview').src = '/views/public/images/avatar.png';
            document.getElementById('form-title').innerText = 'NEW RECORD';

            // Disable uploads and AI until saved
            this.setUploadsState(false);
            this.aiScanBtn.disabled = true;
        }
    }

    setUploadsState(enabled) {
        const avatarInput = document.getElementById('char-avatar-input');
        const refInput = document.getElementById('char-reference-input');
        if (!avatarInput || !refInput) return;

        const avatarLabel = avatarInput.closest('label');
        const refLabel = refInput.closest('label');

        // We don't disable the input anymore, we intercept the click on the label
        // to show a helpful message if not enabled.
        if (enabled) {
            if (avatarLabel) {
                avatarLabel.style.opacity = '1';
                avatarLabel.style.cursor = 'pointer';
                avatarLabel.title = "";
            }
            if (refLabel) {
                refLabel.style.opacity = '1';
                refLabel.style.cursor = 'pointer';
                refLabel.title = "";
            }
        } else {
            if (avatarLabel) {
                avatarLabel.style.opacity = '0.5';
                avatarLabel.style.cursor = 'pointer'; // Keep pointer to encourage click
                avatarLabel.title = "Save character record first to enable uploads";
            }
            if (refLabel) {
                refLabel.style.opacity = '0.5';
                refLabel.style.cursor = 'pointer';
                refLabel.title = "Save character record first to enable uploads";
            }
        }
    }

    async handleAIScan() {
        if (!this.activeCharacterId) {
            return alert("Please Save the character record first to enable AI Profile Scanning.");
        }

        const originalText = this.aiScanBtn.textContent;
        this.aiScanBtn.disabled = true;
        this.aiScanBtn.textContent = "Scanning...";

        try {
            const res = await fetch(`/api/characters/${this.activeCharacterId}/analyze-avatar`, {
                method: 'POST'
            });
            const data = await res.json();
            if (data.ok) {
                document.getElementById('char-description').value = data.description;
                // Optional: display hashtags somewhere or alert
                console.log("[AI Scan] Tags:", data.hashtags);
                alert("AI Scan Complete! Profile updated.");
            } else {
                throw new Error(data.message);
            }
        } catch (e) {
            alert("AI Scan Failed: " + e.message);
        } finally {
            this.aiScanBtn.disabled = false;
            this.aiScanBtn.textContent = originalText;
        }
    }

    renderReferences(images) {
        const refGrid = document.getElementById('char-references-grid');
        refGrid.innerHTML = '';
        images.forEach(imgSrc => {
            const img = document.createElement('img');
            img.src = imgSrc;
            img.className = 'ref-thumb';
            refGrid.appendChild(img);
        });
    }

    hideForm() {
        this.container.classList.remove('editing');
        this.formContainer.classList.add('hidden');
        this.listContainer.classList.remove('hidden');
        this.createBtn.classList.remove('hidden');
    }

    async handleAvatarUpload(e) {
        if (!this.activeCharacterId) return;
        const file = e.target.files[0];
        if (!file) return;

        const fd = new FormData();
        fd.append('avatar', file);

        try {
            const res = await fetch(`/api/characters/${this.activeCharacterId}/avatar`, {
                method: 'POST',
                body: fd
            });
            const data = await res.json();
            if (data.ok) {
                document.getElementById('char-avatar-preview').src = data.image;
                this.aiScanBtn.disabled = false; // Enable AI Scan now that we have an image
                this.loadCharacters(); // Refresh list
            } else {
                alert('Avatar upload failed: ' + data.message);
            }
        } catch (e) { console.error(e); }
    }

    async handleReferenceUpload(e) {
        if (!this.activeCharacterId) return;
        const file = e.target.files[0];
        if (!file) return;

        const fd = new FormData();
        fd.append('image', file);

        try {
            const res = await fetch(`/api/characters/${this.activeCharacterId}/reference`, {
                method: 'POST',
                body: fd
            });
            const data = await res.json();
            if (data.ok) {
                this.renderReferences(data.referenceImages);
            } else {
                alert('Reference upload failed: ' + data.message);
            }
        } catch (e) {
            console.error(e);
            alert('Upload error');
        }
    }

    async saveCharacter() {
        const name = document.getElementById('char-name').value;
        const description = document.getElementById('char-description').value;
        const dialogueStylePrompt = document.getElementById('char-dialogue-style') ? document.getElementById('char-dialogue-style').value : '';

        if (!name) return alert('Name is required');
        if (!this.activeSeriesId) return alert('Choose a story first.');

        const payload = {
            name,
            description,
            dialogueStylePrompt,
            story: this.activeSeriesId   // the story folder this cast belongs to
        };

        try {
            let url = '/api/characters';
            let method = 'POST';

            if (this.activeCharacterId) {
                url += '/' + this.activeCharacterId;
                method = 'PUT';
            }

            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (data.ok) {
                if (window.GlassToast) {
                    window.GlassToast.show('success', 'Saved', `Character '${name}' successfully updated.`);
                }
                this.hideForm();
                this.loadCharacters();
            } else {
                alert('Error: ' + data.message);
            }
        } catch (e) { console.error(e); }
    }
}