const GitHubService = require('../services/git/GitHubService');
const BackupService = require('../services/git/BackupService');
const StorageService = require('../services/StorageService');

/**
 * GitController
 *
 * Manuscript backup: connect a GitHub account, choose or create somewhere to
 * put the work, and push it.
 *
 * The token never comes back out. Every response says whether an account is
 * connected and who it belongs to, never the credential itself — a settings
 * page that renders a token into the DOM has published it to anything that can
 * read the page.
 */

/** Never let a stored token reach the client. */
function safe(connection, extra = {}) {
    return {
        connected: connection.connected,
        owner: connection.owner,
        repo: connection.repo,
        private: connection.private,
        ...extra
    };
}

/**
 * Everything the settings page and the rail button need in one call: is an
 * account connected, which repository, and what state is the story folder in.
 */
exports.getStatus = async (req, res) => {
    try {
        const connection = await GitHubService.getConnection();
        const root = await StorageService.getStoryRoot();

        const repo = root ? await BackupService.status(root) : null;

        res.json({
            ok: true,
            ...safe(connection),
            tokenUrl: GitHubService.tokenUrl,
            storyRoot: root || null,
            repoState: repo
        });
    } catch (err) {
        console.error('[Git] Status failed:', err.message);
        res.status(500).json({ ok: false, message: err.message });
    }
};

/**
 * Save a token, but only after proving it works.
 *
 * Validating at paste time turns a mistyped token into an immediate, obvious
 * error instead of a backup that fails minutes later for reasons the writer
 * cannot see.
 */
exports.connect = async (req, res) => {
    const { token } = req.body || {};
    if (typeof token !== 'string' || !token.trim()) {
        return res.status(400).json({ ok: false, message: 'Paste a GitHub token to connect.' });
    }

    try {
        const account = await GitHubService.validate(token.trim());
        await GitHubService.saveToken(token.trim());

        console.log(`[Git] Connected GitHub account ${account.login}.`);
        res.json({
            ok: true,
            login: account.login,
            name: account.name,
            warning: account.warning
        });
    } catch (err) {
        console.error('[Git] Connect failed:', err.message);
        res.status(400).json({ ok: false, message: err.message });
    }
};

exports.disconnect = async (req, res) => {
    try {
        await GitHubService.clear();
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
};

exports.listRepos = async (req, res) => {
    try {
        const token = await GitHubService.getToken();
        if (!token) return res.status(400).json({ ok: false, message: 'Connect a GitHub account first.' });

        res.json({ ok: true, repos: await GitHubService.listRepos(token) });
    } catch (err) {
        console.error('[Git] Could not list repositories:', err.message);
        res.status(500).json({ ok: false, message: err.message });
    }
};

/**
 * Create a repository. Always private — see GitHubService.
 */
exports.createRepo = async (req, res) => {
    const { name } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ ok: false, message: 'Give the repository a name.' });
    }

    try {
        const token = await GitHubService.getToken();
        if (!token) return res.status(400).json({ ok: false, message: 'Connect a GitHub account first.' });

        const repo = await GitHubService.createRepo(token, name.trim());
        await GitHubService.setRepo({ owner: repo.owner, repo: repo.name, isPrivate: repo.private });

        console.log(`[Git] Created private repository ${repo.fullName}.`);
        res.json({ ok: true, repo });
    } catch (err) {
        console.error('[Git] Create failed:', err.message);
        res.status(400).json({ ok: false, message: err.message });
    }
};

/** Point the backup at a repository the writer already has. */
exports.selectRepo = async (req, res) => {
    const { owner, repo, isPrivate } = req.body || {};
    if (!owner || !repo) {
        return res.status(400).json({ ok: false, message: 'Choose a repository.' });
    }

    try {
        await GitHubService.setRepo({ owner, repo, isPrivate });
        res.json({ ok: true, owner, repo });
    } catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
};

/**
 * Stop tracking narration a hand-built repository already committed.
 *
 * Separate from the backup itself and never automatic: it changes what git
 * tracks, and that is the writer's call to make knowingly.
 */
exports.untrackAudio = async (req, res) => {
    try {
        const root = await StorageService.requireStoryRoot();
        await BackupService.writeIgnore(root);
        const removed = await BackupService.untrackAudio(root);

        console.log(`[Git] Untracked ${removed.length} audio file(s).`);
        res.json({ ok: true, removed, message: `${removed.length} audio file(s) will no longer be backed up. They are still on disk.` });
    } catch (err) {
        console.error('[Git] Untrack failed:', err.message);
        res.status(500).json({ ok: false, message: err.message });
    }
};

/** The button. Commit whatever changed and push it. */
exports.backup = async (req, res) => {
    try {
        const root = await StorageService.requireStoryRoot();
        const connection = await GitHubService.getConnection();
        const token = await GitHubService.getToken();

        if (!token) return res.status(400).json({ ok: false, message: 'Connect a GitHub account in Settings first.' });
        if (!connection.repo) return res.status(400).json({ ok: false, message: 'Choose a repository in Settings first.' });

        const result = await BackupService.backup({
            dir: root,
            token,
            owner: connection.owner,
            repo: connection.repo,
            message: req.body?.message || BackupService.buildMessage(req.body?.stats || {}),
            author: req.body?.author
        });

        console.log(`[Git] Backed up ${result.files} file(s) to ${connection.owner}/${connection.repo}.`);
        res.json({ ok: true, ...result });
    } catch (err) {
        console.error('[Git] Backup failed:', err.message);
        res.status(500).json({ ok: false, message: err.message });
    }
};
