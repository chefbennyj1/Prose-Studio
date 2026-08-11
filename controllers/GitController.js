const path = require('path');
const GitHubService = require('../services/git/GitHubService');
const BackupService = require('../services/git/BackupService');
const StorageService = require('../services/StorageService');
const ManuscriptService = require('../services/manuscript/ManuscriptService');

/**
 * GitController
 *
 * Manuscript backup, one repository per story.
 *
 * The story root is the parent folder every story sits inside, so treating it
 * as a single repository swept unrelated work in with the novel — a scratch
 * story used for benchmarking went up alongside the real manuscript on the
 * first run. A novel is the unit a writer thinks in, so it is the unit that
 * gets a repository, and the backup button pushes whichever story is open.
 *
 * The token never comes back out. Responses say whether an account is
 * connected and which repository a story maps to, never the credential — a
 * settings page that renders a token into the DOM has published it to anything
 * that can read the page.
 */

/** The folder one story lives in, checked to be inside the root. */
async function storyDir(story) {
    const root = await StorageService.requireStoryRoot();
    if (!story) throw new Error('No story is open.');
    if (!StorageService.isSafeSegment(story)) throw new Error('That story name cannot be used.');
    return path.join(root, story);
}

/**
 * Everything Settings and the backup button need: is an account connected,
 * every story with where it backs up to, and — when a story is named — the
 * state of that story's own folder.
 */
exports.getStatus = async (req, res) => {
    try {
        const connection = await GitHubService.getConnection();
        const root = await StorageService.getStoryRoot();
        const story = req.query.story || null;

        let mapping = null;
        let repoState = null;

        if (story && root) {
            mapping = await GitHubService.getRepoFor(story);
            repoState = await BackupService.status(path.join(root, story));
        }

        res.json({
            ok: true,
            connected: connection.connected,
            tokenUrl: GitHubService.tokenUrl,
            storyRoot: root || null,
            story,
            mapping,
            repoState
        });
    } catch (err) {
        console.error('[Git] Status failed:', err.message);
        res.status(500).json({ ok: false, message: err.message });
    }
};

/** Every story on disk, with the repository it backs up to (or none). */
exports.listStories = async (req, res) => {
    try {
        const stories = await ManuscriptService.listStories();
        const mappings = await GitHubService.listMappings();

        res.json({
            ok: true,
            stories: stories.map(s => {
                const mapping = mappings.find(m => m.story === s.name) || null;
                return {
                    name: s.name,
                    chapters: s.chapters,
                    mapping,
                    suggested: GitHubService.suggestRepoName(s.name)
                };
            })
        });
    } catch (err) {
        console.error('[Git] Could not list stories:', err.message);
        res.status(500).json({ ok: false, message: err.message });
    }
};

exports.connect = async (req, res) => {
    const { token } = req.body || {};
    if (typeof token !== 'string' || !token.trim()) {
        return res.status(400).json({ ok: false, message: 'Paste a GitHub token to connect.' });
    }

    try {
        const account = await GitHubService.validate(token.trim());
        await GitHubService.saveToken(token.trim());

        console.log(`[Git] Connected GitHub account ${account.login}.`);
        res.json({ ok: true, login: account.login, name: account.name, warning: account.warning });
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

/** Create a repository for one story. Always private — see GitHubService. */
exports.createRepo = async (req, res) => {
    const { name, story } = req.body || {};
    if (!story) return res.status(400).json({ ok: false, message: 'Say which story this is for.' });
    if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ ok: false, message: 'Give the repository a name.' });
    }

    try {
        const token = await GitHubService.getToken();
        if (!token) return res.status(400).json({ ok: false, message: 'Connect a GitHub account first.' });

        const repo = await GitHubService.createRepo(token, name.trim());
        await GitHubService.setRepoFor(story, { owner: repo.owner, repo: repo.name, isPrivate: repo.private });

        console.log(`[Git] Created private repository ${repo.fullName} for "${story}".`);
        res.json({ ok: true, repo });
    } catch (err) {
        console.error('[Git] Create failed:', err.message);
        res.status(400).json({ ok: false, message: err.message });
    }
};

/** Point a story at a repository the writer already has, or unlink it. */
exports.selectRepo = async (req, res) => {
    const { story, owner, repo, isPrivate } = req.body || {};
    if (!story) return res.status(400).json({ ok: false, message: 'Say which story this is for.' });

    try {
        if (!owner || !repo) {
            await GitHubService.removeRepoFor(story);
            return res.json({ ok: true, story, mapping: null });
        }

        await GitHubService.setRepoFor(story, { owner, repo, isPrivate });
        res.json({ ok: true, story, mapping: { story, owner, repo, private: isPrivate !== false } });
    } catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
};

/**
 * Stop tracking narration a hand-built repository already committed. Scoped to
 * one story, since that is what a repository now is.
 */
exports.untrackAudio = async (req, res) => {
    try {
        const dir = await storyDir(req.body?.story);
        await BackupService.writeIgnore(dir);
        const removed = await BackupService.untrackAudio(dir);

        console.log(`[Git] Untracked ${removed.length} audio file(s) in "${req.body.story}".`);
        res.json({
            ok: true,
            removed,
            message: `${removed.length} audio file(s) will no longer be backed up. They are still on disk.`
        });
    } catch (err) {
        console.error('[Git] Untrack failed:', err.message);
        res.status(500).json({ ok: false, message: err.message });
    }
};

/** The button. Commit and push the story that is open. */
exports.backup = async (req, res) => {
    const story = req.body?.context?.story || req.body?.story;

    try {
        const dir = await storyDir(story);
        const token = await GitHubService.getToken();
        const mapping = await GitHubService.getRepoFor(story);

        if (!token) return res.status(400).json({ ok: false, message: 'Connect a GitHub account in Settings first.' });
        if (!mapping) {
            return res.status(400).json({
                ok: false,
                message: `"${story}" is not backed up yet. Give it a repository under Settings → Manuscript Backup.`
            });
        }

        const result = await BackupService.backup({
            dir,
            token,
            owner: mapping.owner,
            repo: mapping.repo,
            message: req.body?.message || null,
            context: req.body?.context || { story },
            author: req.body?.author
        });

        console.log(`[Git] Backed up "${story}" (${result.files} file(s)) to ${mapping.owner}/${mapping.repo}.`);
        res.json({ ok: true, story, ...result });
    } catch (err) {
        console.error('[Git] Backup failed:', err.message);
        res.status(500).json({ ok: false, message: err.message });
    }
};
