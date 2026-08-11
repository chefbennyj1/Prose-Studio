// views/dashboard/sections/library-settings/github-settings.js

/**
 * The Manuscript Backup block in Settings.
 *
 * Connect a GitHub account, then give each story its own repository. A story
 * with no repository is simply not backed up, which is how a scratch or
 * benchmark story stays out of a manuscript's history.
 *
 * ONE REPOSITORY PER STORY. The first version backed up the story root — the
 * parent folder every story sits inside — as a single repository, so the first
 * real run pushed a test story up alongside the novel. A novel is the unit a
 * writer thinks in, so it is the unit that gets a repository.
 *
 * The token is write-only from here. It is posted once, validated server-side,
 * stored encrypted, and never sent back, so this page can say *that* an account
 * is connected and never redisplay the credential itself.
 *
 * Repositories this creates are always private. There is no control for it on
 * purpose; see GitHubService.
 */

import { escapeHtml } from '../../components/Editor/EditorRender.js';

let repos = [];     // everything on the account, for the dropdowns
let els = {};

export function initGitHubSettings() {
    els = {
        disconnected: document.getElementById('github-disconnected'),
        connected: document.getElementById('github-connected'),
        token: document.getElementById('github-token'),
        tokenLink: document.getElementById('github-token-link'),
        connectBtn: document.getElementById('github-connect-btn'),
        disconnectBtn: document.getElementById('github-disconnect-btn'),
        account: document.getElementById('github-account'),
        stories: document.getElementById('github-stories'),
        status: document.getElementById('github-status')
    };
    if (!els.connectBtn) return;

    els.connectBtn.addEventListener('click', connect);
    els.disconnectBtn.addEventListener('click', disconnect);

    // One listener for every row, so rows can be redrawn freely.
    els.stories.addEventListener('change', onRowChange);
    els.stories.addEventListener('click', onRowClick);

    refresh();
}

function say(message, tone = 'muted') {
    els.status.textContent = message;
    els.status.className = `font-size-07 margin-t-15 text-${tone}`;
}

function busy(btn, on, label) {
    if (!btn) return;
    btn.disabled = on;
    if (on) { btn.dataset.idle = btn.textContent; btn.textContent = label; }
    else if (btn.dataset.idle) { btn.textContent = btn.dataset.idle; }
}

async function refresh() {
    try {
        const status = await (await fetch('/api/git/status')).json();
        if (!status.ok) throw new Error(status.message);

        if (els.tokenLink && status.tokenUrl) els.tokenLink.href = status.tokenUrl;
        els.disconnected.hidden = status.connected;
        els.connected.hidden = !status.connected;

        if (!status.storyRoot) {
            say('No story folder is set yet. Choose one above before backing anything up.');
            return;
        }
        if (!status.connected) return;

        await loadRepos();
        await drawStories();
    } catch (err) {
        say(err.message, 'danger');
    }
}

async function loadRepos() {
    try {
        const data = await (await fetch('/api/git/repos')).json();
        repos = data.ok ? data.repos : [];
    } catch {
        repos = [];
    }
}

/** A row per story: where it backs up to, or an offer to set it up. */
async function drawStories() {
    const data = await (await fetch('/api/git/stories')).json();
    if (!data.ok) throw new Error(data.message);

    if (!data.stories.length) {
        els.stories.innerHTML = '<p class="text-muted">No stories yet. Create one from the rail.</p>';
        return;
    }

    els.stories.innerHTML = data.stories.map(story => {
        const mapped = story.mapping;
        const options = ['<option value="">Not backed up</option>']
            .concat(repos.map(r => {
                const selected = mapped && r.owner === mapped.owner && r.name === mapped.repo ? ' selected' : '';
                const lock = r.private ? '🔒 ' : '⚠ public — ';
                return `<option value="${escapeHtml(r.owner)}/${escapeHtml(r.name)}"
                    data-private="${r.private}"${selected}>${lock}${escapeHtml(r.fullName)}</option>`;
            }))
            .join('');

        const warning = mapped && mapped.private === false
            ? '<p class="font-size-07 text-danger margin-t-5">This repository is PUBLIC. Anyone can read this manuscript.</p>'
            : '';

        return `
        <div class="border-dim padding-20 border-radius-8 margin-b-15" data-story="${escapeHtml(story.name)}">
            <div class="flex-row align-center gap-10">
                <strong class="flex-1">${escapeHtml(story.name)}</strong>
                <span class="font-size-07 text-muted">${story.chapters} chapter${story.chapters === 1 ? '' : 's'}</span>
            </div>

            <div class="form-group margin-t-10">
                <select class="glass-select width-100" data-role="repo">${options}</select>
                ${warning}
            </div>

            <div class="flex-row gap-10 align-center margin-t-10">
                <input type="text" class="glass-input flex-1" data-role="new-name"
                    placeholder="${escapeHtml(story.suggested)}" autocomplete="off">
                <button type="button" class="glass glass-btn glass-btn--sm" data-role="create">
                    Create private repo
                </button>
            </div>

            <div data-role="audio" class="margin-t-10" hidden>
                <p class="font-size-07 text-danger margin-0" data-role="audio-detail"></p>
                <button type="button" class="glass glass-btn glass-btn--sm margin-t-5" data-role="untrack">
                    Stop backing up audio
                </button>
            </div>
        </div>`;
    }).join('');

    // Audio is a property of the story's own folder, so each mapped row is
    // checked separately once the rows exist.
    for (const story of data.stories) {
        if (story.mapping) checkAudio(story.name);
    }
}

/** Warn when a story's repository is already carrying rendered narration. */
async function checkAudio(story) {
    try {
        const data = await (await fetch(`/api/git/status?story=${encodeURIComponent(story)}`)).json();
        const tracked = data.repoState?.trackedAudio || [];
        if (!tracked.length) return;

        const row = els.stories.querySelector(`[data-story="${CSS.escape(story)}"]`);
        if (!row) return;

        row.querySelector('[data-role="audio"]').hidden = false;
        row.querySelector('[data-role="audio-detail"]').textContent =
            `${tracked.length} rendered audio file(s) are tracked by git here. They are large and `
            + 'rebuildable from the text in seconds. Removing them leaves them on disk.';
    } catch { /* the warning is a nicety; never block the page for it */ }
}

/* ---------- actions ---------- */

async function connect() {
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
        els.account.textContent = data.name;
        say(data.warning || `Connected as ${data.name}. Now give each story a repository.`,
            data.warning ? 'danger' : 'muted');
        await refresh();
        document.dispatchEvent(new CustomEvent('githubSettingsChanged'));
    } catch (err) {
        say(err.message, 'danger');
    } finally {
        busy(els.connectBtn, false);
    }
}

async function disconnect() {
    await fetch('/api/git/disconnect', { method: 'POST' });
    say('Disconnected. Your repositories and their history are untouched.');
    await refresh();
    document.dispatchEvent(new CustomEvent('githubSettingsChanged'));
}

async function onRowChange(event) {
    const select = event.target.closest('[data-role="repo"]');
    if (!select) return;

    const story = select.closest('[data-story]').dataset.story;
    const [owner, repo] = (select.value || '').split('/');
    const isPrivate = select.selectedOptions[0]?.dataset.private === 'true';

    const res = await fetch('/api/git/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ story, owner: owner || null, repo: repo || null, isPrivate })
    });
    const data = await res.json();

    if (!data.ok) return say(data.message, 'danger');

    say(owner
        ? `"${story}" backs up to ${owner}/${repo}.${isPrivate ? '' : ' WARNING: that repository is PUBLIC.'}`
        : `"${story}" will not be backed up.`, owner && !isPrivate ? 'danger' : 'muted');

    document.dispatchEvent(new CustomEvent('githubSettingsChanged'));
    if (owner) checkAudio(story);
}

async function onRowClick(event) {
    const row = event.target.closest('[data-story]');
    if (!row) return;
    const story = row.dataset.story;

    const createBtn = event.target.closest('[data-role="create"]');
    if (createBtn) {
        const input = row.querySelector('[data-role="new-name"]');
        const name = (input.value.trim() || input.placeholder).trim();

        busy(createBtn, true, 'Creating…');
        try {
            const res = await fetch('/api/git/repos', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, story })
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.message);

            say(`Created ${data.repo.fullName} (private) for "${story}".`);
            await refresh();
            document.dispatchEvent(new CustomEvent('githubSettingsChanged'));
        } catch (err) {
            say(err.message, 'danger');
        } finally {
            busy(createBtn, false);
        }
        return;
    }

    const untrackBtn = event.target.closest('[data-role="untrack"]');
    if (untrackBtn) {
        busy(untrackBtn, true, 'Working…');
        try {
            const res = await fetch('/api/git/untrack-audio', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ story })
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.message);

            say(data.message);
            await refresh();
        } catch (err) {
            say(err.message, 'danger');
        } finally {
            busy(untrackBtn, false);
        }
    }
}
