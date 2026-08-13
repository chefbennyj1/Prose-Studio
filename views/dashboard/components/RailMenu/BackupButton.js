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

// Which story and chapter is open, for the commit message. Tracked from the
// event the editor already dispatches rather than read out of the DOM.
let where = { story: null, chapter: null };

export function initBackupButton() {
    // The button lives in the editor section, which is injected on navigation
    // rather than present at start-up. Editor.js announces when it is built.
    document.addEventListener('editorReady', attach);

    document.addEventListener('githubSettingsChanged', refresh);

    // Which story is open decides which repository the button targets, so a
    // change of story is a change of target and the state has to be re-read.
    document.addEventListener('manuscriptOpened', (event) => {
        where = { story: event.detail?.story || null, chapter: event.detail?.chapter || null };
        refresh();
    });

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
        // Scoped to the open story: one repository per story, so the state
        // being reported is that story's folder, not the root above it.
        const query = where.story ? `?story=${encodeURIComponent(where.story)}` : '';
        const data = await (await fetch(`/api/git/status${query}`)).json();
        if (!data.ok) throw new Error(data.message);

        els.btn.classList.toggle('hidden', !data.connected);
        if (!data.connected) return;

        missing = !where.story ? 'story' : !data.mapping ? 'repo' : !data.storyRoot ? 'root' : null;
        canBackup = !missing;

        if (!canBackup) {
            els.btn.classList.add('is-unconfigured');
            els.btn.classList.remove('is-clean');
            els.label.textContent = 'Back up';
            els.btn.title = missing === 'story'
                ? 'Open a story to back it up'
                : missing === 'repo'
                    ? `"${where.story}" has no repository yet — set one in Settings`
                    : 'Set a story folder in Settings before backing up';
            return;
        }

        els.btn.classList.remove('is-unconfigured');

        const target = `${data.mapping.owner}/${data.mapping.repo}`;
        const pending = data.repoState?.changed || 0;
        els.label.textContent = pending ? `Back up (${pending})` : 'Backed up';
        els.btn.classList.toggle('is-clean', pending === 0);
        els.btn.title = pending
            ? `${pending} file${pending === 1 ? '' : 's'} of "${where.story}" to push to ${target}`
            : `"${where.story}" is up to date on GitHub at ${target}`;
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
        toast('info', 'Not set up yet',
            missing === 'story' ? 'Open a story first.'
                : missing === 'repo' ? `Give "${where.story}" a repository under Settings → Manuscript Backup.`
                    : 'Set a story folder under Settings before backing up.');
        return;
    }

    running = true;
    els.btn.disabled = true;
    els.label.textContent = 'Backing up…';
    if (els.icon) els.icon.setAttribute('name', 'cloud-upload');

    try {
        // Where the writer was working, so the commit can be found later by
        // what they were doing rather than only by date.
        //
        // NOT the word count. That reads the editor, which holds one chapter,
        // while the commit covers the whole story root — so it labelled a
        // commit containing several stories with a single chapter's total.
        const res = await fetch('/api/git/backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context: where })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.message);

        /*
         * Name the branch, but ONLY when it is not the one this app would have
         * made. "No branches" is right for a novelist and stays the default:
         * a repository Prose Studio created is on `main` and never mentions it.
         *
         * A repository that predates this feature, or was made by hand, is very
         * often on `master` - and the backup pushes there deliberately, so as
         * not to fork a second branch beside the writer's real history. If
         * GitHub's default for that repository is `main`, the web UI then opens
         * on a branch the manuscript is not on and the chapters look missing.
         * The push worked; the page was the wrong page. Saying where it went is
         * the difference between that costing a minute and costing an evening.
         */
        const onBranch = data.branch && data.branch !== 'main'
            ? ` on branch "${data.branch}"`
            : '';

        if (data.committed) {
            toast('success', 'Backed up',
                `${data.committed.files} file${data.committed.files === 1 ? '' : 's'} pushed to GitHub${onBranch}.`);
        } else {
            toast('info', 'Already up to date', `Nothing had changed since the last backup${onBranch}.`);
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
