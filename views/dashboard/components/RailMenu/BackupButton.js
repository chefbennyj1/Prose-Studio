// views/dashboard/components/RailMenu/BackupButton.js

/**
 * The Back up button in the editor's bar, beside Save.
 *
 * One press: commit whatever changed in the story folder, push it to GitHub.
 * No branches, no staging area, no rebase — a novelist wants their work
 * somewhere safe, not a version-control workflow. Everything that needs a
 * decision (which account, which repository) was decided once in Settings.
 *
 * It sits beside Save because it is the same kind of act and that is where a
 * writer already looks to see whether their work is safe. It started in the
 * studio rail and was hard to find there, among tools it is not one of.
 *
 * VISIBILITY IS TWO QUESTIONS, NOT ONE. Whether to show it depends only on
 * having a GitHub account connected; whether it can actually run also needs a
 * repository and a story folder. The first version required all three to
 * appear, which made it invisible for anyone who connected an account and
 * stopped there — and a button hidden on purpose is indistinguishable from one
 * that is broken. Now it shows, and says what is missing.
 */

let els = {};
let canBackup = false;
let missing = null;
let running = false;
let saveTimer = null;

export function initBackupButton() {
    // The button lives in the editor section, which is injected on navigation
    // rather than present at start-up. Editor.js announces when it is built.
    document.addEventListener('editorReady', attach);

    document.addEventListener('githubSettingsChanged', refresh);

    // Saving changes what is waiting to go up. Debounced, because autosave
    // fires every few seconds while typing and each check walks the folder.
    document.addEventListener('manuscriptSaved', () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(refresh, 4000);
    });

    // In case the editor is already on screen when this runs.
    attach();
}

function attach() {
    const btn = document.getElementById('backupBtn');
    if (!btn) return;

    els = {
        btn,
        icon: document.getElementById('backupIcon'),
        label: document.getElementById('backupLabel')
    };

    // The node is rebuilt with the section, so this binds the current one.
    els.btn.addEventListener('click', run);
    refresh();
}

async function refresh() {
    if (!els.btn || !document.body.contains(els.btn)) return;

    try {
        const data = await (await fetch('/api/git/status')).json();
        if (!data.ok) throw new Error(data.message);

        els.btn.classList.toggle('hidden', !data.connected);
        if (!data.connected) return;

        missing = !data.repo ? 'repo' : !data.storyRoot ? 'root' : null;
        canBackup = !missing;

        if (!canBackup) {
            els.btn.classList.add('is-unconfigured');
            els.label.textContent = 'Back up';
            els.btn.title = missing === 'repo'
                ? 'Choose a repository in Settings before backing up'
                : 'Set a story folder in Settings before backing up';
            return;
        }

        els.btn.classList.remove('is-unconfigured');

        const pending = data.repoState?.changed || 0;
        els.label.textContent = pending ? `Back up (${pending})` : 'Backed up';
        els.btn.classList.toggle('is-clean', pending === 0);
        els.btn.title = pending
            ? `${pending} file${pending === 1 ? '' : 's'} to push to ${data.owner}/${data.repo}`
            : `Everything is on GitHub at ${data.owner}/${data.repo}`;
    } catch (err) {
        console.warn('[Backup] Could not read status:', err.message);
        els.btn.classList.add('hidden');
    }
}

async function run() {
    if (running) return;

    const toast = (type, title, message) => window.GlassToast?.show(type, title, message);

    // Pressed while something is missing: say which, rather than doing nothing.
    if (!canBackup) {
        toast('info', 'Not set up yet', missing === 'repo'
            ? 'Choose a repository under Settings → Manuscript Backup.'
            : 'Set a story folder under Settings before backing up.');
        return;
    }

    running = true;
    els.btn.disabled = true;
    els.label.textContent = 'Backing up…';
    if (els.icon) els.icon.setAttribute('name', 'cloud-upload');

    try {
        // The word count rides along so the commit message says something the
        // writer will recognise in their own history.
        const words = Number(
            (document.getElementById('editorWordCount')?.textContent || '').replace(/[^\d]/g, '')
        ) || 0;

        const res = await fetch('/api/git/backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stats: { words } })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.message);

        if (data.committed) {
            toast('success', 'Backed up',
                `${data.committed.files} file${data.committed.files === 1 ? '' : 's'} pushed to GitHub.`);
        } else {
            toast('info', 'Already up to date', 'Nothing had changed since the last backup.');
        }
    } catch (err) {
        // Written for a writer, not for someone who uses git — see
        // BackupService.explainPushError.
        toast('error', 'Backup failed', err.message);
    } finally {
        running = false;
        els.btn.disabled = false;
        if (els.icon) els.icon.setAttribute('name', 'cloud-upload-outline');
        refresh();
    }
}
