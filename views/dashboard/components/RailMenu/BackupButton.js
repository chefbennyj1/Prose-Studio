// views/dashboard/components/RailMenu/BackupButton.js

/**
 * The Back up button in the studio rail.
 *
 * One press: commit whatever changed in the story folder, push it to GitHub.
 * No branches, no staging area, no rebase — a novelist wants their work
 * somewhere safe, not a version-control workflow. Everything that needs a
 * decision (which account, which repository) was decided once in Settings.
 *
 * Hidden until an account and a repository are both configured, on the same
 * reasoning as the AI rows in the Review menu: a control that can only ever
 * produce an error is worse than no control.
 *
 * The badge counts files waiting to go up, so "have I backed up today?" is
 * answerable from the rail without opening anything.
 */

let els = {};
let ready = false;
let running = false;

export function initBackupButton() {
    els = {
        btn: document.getElementById('backupBtn'),
        badge: document.getElementById('backupBadge'),
        icon: document.querySelector('#backupBtn ion-icon')
    };
    if (!els.btn) return;

    els.btn.addEventListener('click', (event) => {
        event.stopPropagation();   // not a section button; the rail must not navigate
        run();
    });

    // Saving changes what is pending, so the count is refreshed after one.
    // Debounced: autosave fires every few seconds while typing and each check
    // walks the story folder.
    let timer = null;
    document.addEventListener('manuscriptSaved', () => {
        clearTimeout(timer);
        timer = setTimeout(refresh, 4000);
    });

    document.addEventListener('githubSettingsChanged', refresh);

    refresh();
}

async function refresh() {
    if (running) return;

    try {
        const data = await (await fetch('/api/git/status')).json();
        if (!data.ok) throw new Error(data.message);

        ready = !!(data.connected && data.repo && data.storyRoot);
        els.btn.classList.toggle('hidden', !ready);
        if (!ready) return;

        const pending = data.repoState?.changed || 0;
        drawBadge(pending);

        els.btn.title = pending
            ? `Back up to GitHub — ${pending} file${pending === 1 ? '' : 's'} changed`
            : `Backed up to ${data.owner}/${data.repo} — nothing waiting`;
    } catch (err) {
        // A failed check is not worth shouting about; the button simply does
        // not appear, and Settings is where the reason lives.
        console.warn('[Backup] Could not read status:', err.message);
        els.btn.classList.add('hidden');
    }
}

function drawBadge(count) {
    if (!els.badge) return;

    if (!count) {
        els.badge.classList.add('hidden');
        els.badge.textContent = '';
        return;
    }
    els.badge.textContent = count > 99 ? '99+' : String(count);
    els.badge.classList.remove('hidden');
}

async function run() {
    if (running || !ready) return;
    running = true;

    const toast = (type, title, message) =>
        window.GlassToast?.show(type, title, message);

    els.btn.classList.add('is-working');
    if (els.icon) els.icon.setAttribute('name', 'cloud-upload');

    try {
        // The word count rides along so the commit message says something a
        // writer recognises in their own history.
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
        // These messages are written for a writer, not for someone who uses
        // git — see BackupService.explainPushError.
        toast('error', 'Backup failed', err.message);
    } finally {
        running = false;
        els.btn.classList.remove('is-working');
        if (els.icon) els.icon.setAttribute('name', 'cloud-upload-outline');
        refresh();
    }
}
