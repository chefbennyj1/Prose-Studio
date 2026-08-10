// views/dashboard/sections/library-settings/github-settings.js

/**
 * The Manuscript Backup block in Settings.
 *
 * Connect a GitHub account, pick or create somewhere to put the manuscript,
 * and clear up a repository that is already carrying narration audio.
 *
 * The token is write-only from here. It is posted once, validated server-side,
 * stored encrypted, and never sent back — so this page can say *that* an
 * account is connected and *who* it belongs to, and can never redisplay the
 * credential itself.
 *
 * Repositories this creates are always private. There is no control for it on
 * purpose; see GitHubService.
 */

let state = { connected: false, owner: null, repo: null, repoState: null };

export function initGitHubSettings() {
    const els = {
        disconnected: document.getElementById('github-disconnected'),
        connected: document.getElementById('github-connected'),
        token: document.getElementById('github-token'),
        tokenLink: document.getElementById('github-token-link'),
        connectBtn: document.getElementById('github-connect-btn'),
        disconnectBtn: document.getElementById('github-disconnect-btn'),
        account: document.getElementById('github-account'),
        repoSelect: document.getElementById('github-repo-select'),
        repoNote: document.getElementById('github-repo-note'),
        newRepo: document.getElementById('github-new-repo'),
        createBtn: document.getElementById('github-create-btn'),
        audioWarning: document.getElementById('github-audio-warning'),
        audioDetail: document.getElementById('github-audio-detail'),
        untrackBtn: document.getElementById('github-untrack-btn'),
        status: document.getElementById('github-status')
    };
    if (!els.connectBtn) return;

    const say = (message, tone = 'muted') => {
        els.status.textContent = message;
        els.status.className = `font-size-07 margin-t-15 text-${tone}`;
    };

    const busy = (btn, on, label) => {
        btn.disabled = on;
        if (on) { btn.dataset.idle = btn.textContent; btn.textContent = label; }
        else if (btn.dataset.idle) { btn.textContent = btn.dataset.idle; }
    };

    async function refresh() {
        try {
            const data = await (await fetch('/api/git/status')).json();
            if (!data.ok) throw new Error(data.message);

            state = data;
            if (els.tokenLink && data.tokenUrl) els.tokenLink.href = data.tokenUrl;

            els.disconnected.hidden = data.connected;
            els.connected.hidden = !data.connected;

            if (data.connected) {
                els.account.textContent = data.owner || 'GitHub';
                await loadRepos();
                drawRepoNote();
                drawAudioWarning();
            }

            if (!data.storyRoot) {
                say('No story folder is set yet. Choose one above before backing up.', 'muted');
            }
        } catch (err) {
            say(err.message, 'danger');
        }
    }

    /**
     * The repository list, with the folder's own remote pre-selected.
     *
     * A writer who already has a repository has already answered "which one" —
     * their story folder points at it — so that is what this offers first
     * rather than making them find it in a list of a hundred.
     */
    async function loadRepos() {
        try {
            const data = await (await fetch('/api/git/repos')).json();
            if (!data.ok) throw new Error(data.message);

            const chosen = state.repo || state.repoState?.detected?.repo || null;
            const owner = state.owner || state.repoState?.detected?.owner || null;

            els.repoSelect.innerHTML = '<option value="">Choose a repository…</option>'
                + data.repos.map(r => {
                    const selected = r.name === chosen && r.owner === owner ? ' selected' : '';
                    const lock = r.private ? '🔒 ' : '⚠ public — ';
                    return `<option value="${r.owner}/${r.name}" data-private="${r.private}"${selected}>${lock}${r.fullName}</option>`;
                }).join('');
        } catch (err) {
            els.repoSelect.innerHTML = '<option value="">Could not load repositories</option>';
            say(err.message, 'danger');
        }
    }

    function drawRepoNote() {
        const detected = state.repoState?.detected;
        const parts = [];

        if (detected && !state.repo) {
            parts.push(`This folder already points at ${detected.owner}/${detected.repo}.`);
        }
        if (state.repoState?.branch) {
            parts.push(`Branch: ${state.repoState.branch}.`);
        }
        if (state.repoState?.remoteIsSsh) {
            parts.push('Your existing SSH remote is left untouched — backups push over HTTPS with the token.');
        }
        els.repoNote.textContent = parts.join(' ');
    }

    function drawAudioWarning() {
        const tracked = state.repoState?.trackedAudio || [];
        els.audioWarning.hidden = tracked.length === 0;
        if (!tracked.length) return;

        els.audioDetail.textContent =
            `${tracked.length} rendered audio file(s) are being tracked by git. They are large, `
            + 'rebuildable from the text in seconds, and will bloat the repository. '
            + 'Removing them from the backup leaves them on disk.';
    }

    /* ---------- actions ---------- */

    els.connectBtn.addEventListener('click', async () => {
        const token = els.token.value.trim();
        if (!token) return say('Paste a token first.', 'danger');

        busy(els.connectBtn, true, 'Checking…');
        try {
            const res = await fetch('/api/git/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token })
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.message);

            els.token.value = '';   // never leave a credential sitting in the DOM
            say(data.warning || `Connected as ${data.name}.`, data.warning ? 'danger' : 'muted');
            await refresh();
        } catch (err) {
            say(err.message, 'danger');
        } finally {
            busy(els.connectBtn, false);
        }
    });

    els.disconnectBtn.addEventListener('click', async () => {
        await fetch('/api/git/disconnect', { method: 'POST' });
        say('Disconnected. Your repository and its history are untouched.');
        await refresh();
    });

    els.repoSelect.addEventListener('change', async () => {
        const value = els.repoSelect.value;
        if (!value) return;

        const [owner, repo] = value.split('/');
        const isPrivate = els.repoSelect.selectedOptions[0]?.dataset.private === 'true';

        const res = await fetch('/api/git/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ owner, repo, isPrivate })
        });
        const data = await res.json();

        say(data.ok
            ? `Backing up to ${owner}/${repo}.${isPrivate ? '' : ' Warning: this repository is PUBLIC.'}`
            : data.message, data.ok && isPrivate ? 'muted' : 'danger');
    });

    els.createBtn.addEventListener('click', async () => {
        const name = els.newRepo.value.trim();
        if (!name) return say('Give the repository a name.', 'danger');

        busy(els.createBtn, true, 'Creating…');
        try {
            const res = await fetch('/api/git/repos', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.message);

            els.newRepo.value = '';
            say(`Created ${data.repo.fullName} (private). It is now the backup target.`);
            await refresh();
        } catch (err) {
            say(err.message, 'danger');
        } finally {
            busy(els.createBtn, false);
        }
    });

    els.untrackBtn.addEventListener('click', async () => {
        busy(els.untrackBtn, true, 'Working…');
        try {
            const res = await fetch('/api/git/untrack-audio', { method: 'POST' });
            const data = await res.json();
            if (!data.ok) throw new Error(data.message);

            say(data.message);
            await refresh();
        } catch (err) {
            say(err.message, 'danger');
        } finally {
            busy(els.untrackBtn, false);
        }
    });

    refresh();
}
