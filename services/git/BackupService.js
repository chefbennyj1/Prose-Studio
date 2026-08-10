const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const git = require('isomorphic-git');
const http = require('isomorphic-git/http/node');

/**
 * BackupService
 *
 * The local half of manuscript backup: turn the story folder into a git
 * repository, commit what changed, and push it.
 *
 * NO GIT INSTALLATION REQUIRED. isomorphic-git is a pure-JavaScript
 * implementation, so this works for a writer who has never opened a terminal —
 * which is the only way this feature is worth having. The cost is that it
 * speaks HTTP rather than SSH, so authentication is a personal access token.
 *
 * THE AUDIO EXCLUSION IS NOT OPTIONAL. ChapterAudioService renders narration
 * as uncompressed WAV into `<story>/.audio/<chapter>/`, inside the very folder
 * this backs up. A chapter of narration is tens of megabytes; a few of them
 * would push a manuscript repository past what GitHub will accept, for files
 * that are rebuildable from the text in seconds. writeIgnore() runs before the
 * first commit, and health() reports audio that a previous, hand-rolled
 * repository has already swallowed.
 *
 * Prose is small. A novel is a couple of megabytes of text, so nothing here
 * needs to be clever about performance.
 */

const IGNORE_FILE = '.gitignore';

/** Only used for a repository this creates. An existing one keeps its own. */
const DEFAULT_BRANCH = 'main';

/**
 * What a manuscript repository should never carry. `.audio/` matches at any
 * depth, which is what catches `<story>/.audio/<chapter>/`.
 */
const IGNORE_CONTENT = `# Written by Prose Studio.

# Rendered narration. Uncompressed WAV, tens of megabytes a chapter, and
# rebuildable from the text in seconds — it does not belong in a manuscript's
# history and will exhaust a repository's size limits if it gets in.
.audio/
*.wav
*.mp3

# Operating-system and editor noise.
.DS_Store
Thumbs.db
desktop.ini
*~
*.tmp
`;

/** Token as the username is isomorphic-git's documented form for GitHub. */
function auth(token) {
    return () => ({ username: token });
}

function remoteUrl(owner, repo) {
    return `https://github.com/${owner}/${repo}.git`;
}

/**
 * Pull owner and repo out of a remote URL, in either form git writes them:
 *
 *   git@github.com:owner/repo.git
 *   https://github.com/owner/repo.git
 *
 * This is what lets a writer who already has a repository keep it. Their
 * folder already says which one it is, so the app reads that rather than
 * asking them to name it again — and rather than assuming it should attach a
 * different one.
 */
function parseRemote(url) {
    if (!url) return null;

    const ssh = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
    if (ssh) return { owner: ssh[1], repo: ssh[2], ssh: true };

    const https = url.match(/^https?:\/\/(?:[^@]*@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i);
    if (https) return { owner: https[1], repo: https[2], ssh: false };

    return null;
}

class BackupService {
    /**
     * Is this folder a repository, and what is in it?
     *
     * Deliberately tolerant: every question here can answer "no" without that
     * being an error, because a folder that is not yet a repository is the
     * normal starting state rather than a fault.
     */
    async status(dir) {
        const result = {
            isRepo: false,
            remote: null,
            branch: null,
            changed: 0,
            lastCommit: null,
            hasIgnore: false,
            trackedAudio: [],
            detected: null,
            remoteIsSsh: false
        };
        if (!dir) return result;

        try {
            await fsp.access(path.join(dir, '.git'));
            result.isRepo = true;
        } catch {
            return result;
        }

        try {
            const remotes = await git.listRemotes({ fs, dir });
            result.remote = remotes.find(r => r.remote === 'origin')?.url || remotes[0]?.url || null;

            // A folder that already points at a repository has already answered
            // "which one" — read it rather than asking again.
            const parsed = parseRemote(result.remote);
            if (parsed) {
                result.detected = { owner: parsed.owner, repo: parsed.repo };
                result.remoteIsSsh = parsed.ssh;
            }
        } catch { /* a repository with no remote is fine */ }

        try {
            result.branch = await git.currentBranch({ fs, dir, fullname: false }) || null;
        } catch { /* no commits yet, so no branch */ }

        try {
            const log = await git.log({ fs, dir, depth: 1 });
            if (log.length) {
                result.lastCommit = {
                    message: log[0].commit.message.trim().split('\n')[0],
                    when: new Date(log[0].commit.author.timestamp * 1000).toISOString()
                };
            }
        } catch { /* an empty repository has no log */ }

        result.hasIgnore = await this.hasIgnore(dir);
        result.changed = (await this.pendingFiles(dir)).length;

        // Audio that got committed before there was a .gitignore to stop it.
        // Adding the ignore rule now would NOT remove these — git keeps
        // tracking a file it already knows about — so this has to be reported
        // rather than silently assumed handled.
        try {
            const tracked = await git.listFiles({ fs, dir });
            result.trackedAudio = tracked.filter(f =>
                f.includes('.audio/') || /\.(wav|mp3)$/i.test(f));
        } catch { /* nothing committed yet */ }

        return result;
    }

    async hasIgnore(dir) {
        try {
            const body = await fsp.readFile(path.join(dir, IGNORE_FILE), 'utf8');
            return body.includes('.audio/');
        } catch {
            return false;
        }
    }

    /**
     * Write the ignore rules, preserving anything already there.
     *
     * A writer may have their own entries, and a backup button is no reason to
     * throw them away.
     */
    async writeIgnore(dir) {
        const target = path.join(dir, IGNORE_FILE);

        let existing = '';
        try {
            existing = await fsp.readFile(target, 'utf8');
        } catch { /* none yet */ }

        if (existing.includes('.audio/')) return false;

        const merged = existing.trim()
            ? `${existing.trimEnd()}\n\n${IGNORE_CONTENT}`
            : IGNORE_CONTENT;

        await fsp.writeFile(target, merged, 'utf8');
        return true;
    }

    /**
     * Stop tracking audio a repository already swallowed.
     *
     * Adding `.audio/` to .gitignore does nothing to a file git is already
     * tracking — ignore rules only ever apply to untracked paths. A writer who
     * built their repository by hand before this existed will have narration in
     * their history, and every future backup would keep committing new versions
     * of it unless it is removed from the index.
     *
     * The files stay on disk. This removes them from git's tracking, not from
     * the machine, so nothing has to be re-rendered.
     *
     * It cannot shrink the history that already contains them — that needs a
     * rewrite, which is far too destructive to do behind a button. It stops the
     * bleeding.
     */
    async untrackAudio(dir) {
        const tracked = await git.listFiles({ fs, dir }).catch(() => []);
        const audio = tracked.filter(f => f.includes('.audio/') || /\.(wav|mp3)$/i.test(f));

        for (const filepath of audio) {
            await git.remove({ fs, dir, filepath });
        }
        return audio;
    }

    /**
     * Everything the next commit should contain, each with what to DO about it.
     *
     * The action is decided here rather than inferred later from whether the
     * file is on disk, and that distinction is load-bearing. An ignored file
     * that git already tracks — narration in a repository built before this
     * feature existed — still sits in the working directory after untrackAudio
     * removes it from the index. Judging by "does it exist on disk" would stage
     * it straight back and quietly undo the fix.
     */
    async pendingFiles(dir) {
        const matrix = await git.statusMatrix({ fs, dir });
        const changed = [];

        for (const [filepath, head, workdir, stage] of matrix) {
            if (head === 1 && workdir === 1 && stage === 1) continue;   // unchanged

            let ignored = false;
            try {
                ignored = await git.isIgnored({ fs, dir, filepath });
            } catch { /* an unreadable ignore file means treat it as not ignored */ }

            if (ignored) {
                // Never stage an ignored file. If git was tracking it, the one
                // thing to record is that it is not tracked any more.
                if (head === 1) changed.push({ filepath, action: 'remove', reason: 'ignored' });
                continue;
            }

            changed.push({
                filepath,
                action: workdir === 0 ? 'remove' : 'add',
                reason: workdir === 0 ? 'deleted' : null
            });
        }
        return changed;
    }

    /** Init, set the branch, and lay down the ignore rules before anything is staged. */
    async ensureRepo(dir) {
        let created = false;
        try {
            await fsp.access(path.join(dir, '.git'));
        } catch {
            await git.init({ fs, dir, defaultBranch: DEFAULT_BRANCH });
            created = true;
        }
        const wroteIgnore = await this.writeIgnore(dir);
        return { created, wroteIgnore };
    }

    /**
     * Give a repository an `origin` ONLY if it has none.
     *
     * An earlier version deleted origin and wrote its own. That is fine for a
     * folder this created and quietly destructive for one the writer set up
     * themselves: it would replace a working remote — very possibly an SSH one
     * they push over from the command line — with an HTTPS URL, changing their
     * own workflow as a side effect of pressing a backup button.
     *
     * So an existing remote is left exactly as it is, and the push below goes
     * to an explicit URL instead of through it.
     */
    async ensureRemote(dir, owner, repo) {
        const remotes = await git.listRemotes({ fs, dir }).catch(() => []);
        if (remotes.some(r => r.remote === 'origin')) return { added: false };

        await git.addRemote({ fs, dir, remote: 'origin', url: remoteUrl(owner, repo) });
        return { added: true };
    }

    /**
     * Which branch to push. The repository's own, whatever it is called — a
     * folder set up before `main` became the default is on `master`, and
     * pushing a hard-coded `main` to it would create a second branch beside
     * the writer's actual history rather than updating it.
     */
    async currentBranch(dir) {
        try {
            return (await git.currentBranch({ fs, dir, fullname: false })) || DEFAULT_BRANCH;
        } catch {
            return DEFAULT_BRANCH;
        }
    }

    /**
     * Stage everything that changed, commit it, and push.
     *
     * One button's worth of git. There is no staging area exposed, no branch
     * choice and no rebase, because a novelist wants their work somewhere safe
     * rather than a version-control workflow.
     *
     * @param {object} opts { dir, token, owner, repo, message, author }
     */
    async backup({ dir, token, owner, repo, message, author }) {
        if (!dir) throw new Error('No story folder is set. Choose one in Settings first.');
        if (!token) throw new Error('Connect a GitHub account in Settings first.');
        if (!owner || !repo) throw new Error('Choose a repository in Settings first.');

        await this.ensureRepo(dir);
        await this.ensureRemote(dir, owner, repo);

        const branch = await this.currentBranch(dir);
        const pending = await this.pendingFiles(dir);

        // pendingFiles already decided add-or-remove for each path; git.add on
        // a missing file throws, and re-adding an ignored one undoes the point.
        for (const file of pending) {
            if (file.action === 'remove') await git.remove({ fs, dir, filepath: file.filepath });
            else await git.add({ fs, dir, filepath: file.filepath });
        }

        let committed = null;
        if (pending.length) {
            const sha = await git.commit({
                fs,
                dir,
                message,
                author: {
                    name: author?.name || 'Prose Studio',
                    email: author?.email || 'prose-studio@localhost'
                }
            });
            committed = { sha: sha.slice(0, 7), files: pending.length };
        }

        // Push even with nothing new to commit: the previous run may have
        // committed and then failed to reach GitHub, and the writer pressing
        // the button again means "make sure it is up there".
        try {
            const result = await git.push({
                fs,
                http,
                dir,
                // An explicit URL rather than `remote: 'origin'`. The writer's
                // origin may be an SSH URL, which isomorphic-git cannot speak,
                // and is theirs regardless — this pushes over HTTPS with the
                // token without touching their configuration.
                url: remoteUrl(owner, repo),
                ref: branch,
                remoteRef: branch,
                onAuth: auth(token)
            });

            if (result.error) throw new Error(result.error);
        } catch (err) {
            throw new Error(this.explainPushError(err));
        }

        return {
            committed,
            pushed: true,
            branch,
            files: pending.length,
            url: `https://github.com/${owner}/${repo}`
        };
    }

    /**
     * Git's push failures are written for people who use git. These are the
     * three a writer will actually hit, in words that say what to do.
     */
    explainPushError(err) {
        const raw = String(err?.message || err);

        if (/not a fast-forward|non-fast-forward|rejected/i.test(raw)) {
            return 'GitHub has changes this machine has not seen — usually because the manuscript was edited somewhere else. '
                + 'Nothing was lost and nothing was overwritten. Pull those changes down before backing up again.';
        }
        if (/401|Unauthorized|authentication/i.test(raw)) {
            return 'GitHub refused the token. It may have expired or been revoked — reconnect the account in Settings.';
        }
        if (/403|Forbidden|permission/i.test(raw)) {
            return 'The token does not have permission to write to that repository. It needs the "repo" scope.';
        }
        if (/404|Not Found/i.test(raw)) {
            return 'That repository could not be found. It may have been renamed or deleted on GitHub.';
        }
        if (/ENOTFOUND|EAI_AGAIN|network|fetch failed/i.test(raw)) {
            return 'Could not reach github.com. Check the connection and try again — the commit is saved locally either way.';
        }
        return `Push failed: ${raw}`;
    }

    /** A commit message a writer can read in their own history. */
    buildMessage(stats = {}) {
        const when = new Date().toLocaleDateString('en-GB', {
            day: 'numeric', month: 'short', year: 'numeric'
        });
        const words = Number(stats.words) || 0;
        const parts = [`Manuscript backup — ${when}`];
        if (words) parts.push(`${words.toLocaleString()} words`);
        return parts.join(' · ');
    }
}

module.exports = new BackupService();
