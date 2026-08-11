const GlobalSettings = require('../../models/GlobalSettings');
const { encrypt, decrypt } = require('../../utils/encryption');

/**
 * GitHubService
 *
 * Everything that talks to github.com over its REST API: proving a token
 * works, listing what the writer already has, and creating somewhere to put a
 * manuscript.
 *
 * MANUSCRIPT REPOSITORIES ARE ALWAYS PRIVATE. `private: true` below is not a
 * default, it is the only value this service will send, and there is
 * deliberately no parameter to change it. The worst thing this feature could
 * do is publish an unfinished novel to the open internet, and that must not be
 * one checkbox away. A writer who genuinely wants a public repository can
 * change it on github.com, having thought about it.
 *
 * Tokens are CLASSIC, not fine-grained. A fine-grained token cannot create a
 * repository without Administration write across every repository the account
 * owns, which is a far larger grant than this needs, and it makes the writer
 * hand-pick each repository before it will work. Classic `repo` scope is one
 * checkbox and covers exactly create-and-push.
 */

const API = 'https://api.github.com';

// Pre-fills the token form: description filled, `repo` already ticked. The
// writer generates, copies, pastes. No hunting through settings pages.
const TOKEN_URL = 'https://github.com/settings/tokens/new'
    + '?description=Prose%20Studio%20-%20manuscript%20backup&scopes=repo';

function headers(token) {
    return {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Prose-Studio'
    };
}

/** GitHub's error bodies are JSON but not always; never throw on the parse. */
async function readError(res) {
    try {
        const body = await res.json();
        return body.message || `GitHub returned ${res.status}.`;
    } catch {
        return `GitHub returned ${res.status}.`;
    }
}

class GitHubService {
    get tokenUrl() {
        return TOKEN_URL;
    }

    /* ---------- the stored token ---------- */

    async getToken() {
        try {
            const settings = await GlobalSettings.findOne({ key: 'main' }, 'github').lean();
            if (!settings?.github?.token) return null;
            return decrypt(settings.github.token) || null;
        } catch (err) {
            console.error('[GitHub] Could not read the stored token:', err.message);
            return null;
        }
    }

    async saveToken(token) {
        await GlobalSettings.updateOne(
            { key: 'main' },
            { $set: { 'github.token': encrypt(token) } },
            { upsert: true }
        );
    }

    /** Forgetting the token disconnects the account and every story mapping. */
    async clear() {
        await GlobalSettings.updateOne(
            { key: 'main' },
            { $set: { 'github.token': '', 'github.repos': [] } },
            { upsert: true }
        );
    }

    async getConnection() {
        try {
            const settings = await GlobalSettings.findOne({ key: 'main' }, 'github').lean();
            return { connected: !!settings?.github?.token };
        } catch {
            return { connected: false };
        }
    }

    /** Every story-to-repository mapping the writer has set up. */
    async listMappings() {
        try {
            const settings = await GlobalSettings.findOne({ key: 'main' }, 'github').lean();
            return (settings?.github?.repos || []).filter(m => m.owner && m.repo);
        } catch {
            return [];
        }
    }

    /** Where one story backs up to, or null if it is not backed up. */
    async getRepoFor(story) {
        if (!story) return null;
        const mappings = await this.listMappings();
        return mappings.find(m => m.story === story) || null;
    }

    /**
     * Point a story at a repository, replacing any previous mapping for it.
     *
     * Pulling the old entry first rather than using a positional update: a
     * story that has never been mapped has nothing to match, and $set on a
     * non-existent array element silently does nothing.
     */
    async setRepoFor(story, { owner, repo, isPrivate }) {
        await GlobalSettings.updateOne(
            { key: 'main' },
            { $pull: { 'github.repos': { story } } },
            { upsert: true }
        );
        await GlobalSettings.updateOne(
            { key: 'main' },
            { $push: { 'github.repos': { story, owner, repo, private: isPrivate !== false } } },
            { upsert: true }
        );
    }

    /** Stop backing a story up. The repository on GitHub is left alone. */
    async removeRepoFor(story) {
        await GlobalSettings.updateOne(
            { key: 'main' },
            { $pull: { 'github.repos': { story } } }
        );
    }

    /* ---------- github.com ---------- */

    /**
     * Prove the token works, and say who it belongs to.
     *
     * Called the moment a token is pasted rather than on the first push. A bad
     * token discovered at paste time is a typo; discovered mid-backup it looks
     * like the backup broke.
     */
    async validate(token) {
        const res = await fetch(`${API}/user`, { headers: headers(token) });

        if (res.status === 401) {
            throw new Error('GitHub rejected that token. Check it was copied whole, and that it has not expired.');
        }
        if (!res.ok) throw new Error(await readError(res));

        const user = await res.json();

        // The token must carry `repo`, or creating and pushing to a private
        // repository fails later with a 403 that says nothing useful.
        const scopes = (res.headers.get('x-oauth-scopes') || '')
            .split(',').map(s => s.trim()).filter(Boolean);

        const canWrite = scopes.length === 0 || scopes.includes('repo');
        return {
            login: user.login,
            name: user.name || user.login,
            scopes,
            canWrite,
            warning: canWrite ? null
                : `This token has only: ${scopes.join(', ')}. It needs "repo" to back up a private manuscript.`
        };
    }

    /** Repositories the writer already has, newest activity first. */
    async listRepos(token) {
        const res = await fetch(`${API}/user/repos?per_page=100&sort=pushed&affiliation=owner`, {
            headers: headers(token)
        });
        if (!res.ok) throw new Error(await readError(res));

        return (await res.json()).map(repo => ({
            name: repo.name,
            owner: repo.owner?.login,
            fullName: repo.full_name,
            private: repo.private,
            empty: repo.size === 0,
            url: repo.html_url
        }));
    }

    /**
     * Create somewhere to put a manuscript.
     *
     * `auto_init: false` is load-bearing. With it true GitHub writes a README
     * commit the writer's folder has never seen, so the first push is rejected
     * for unrelated histories — an error that means nothing to a novelist and
     * is genuinely awkward to unpick. An empty repository accepts the local
     * history as-is.
     */
    async createRepo(token, name) {
        const res = await fetch(`${API}/user/repos`, {
            method: 'POST',
            headers: { ...headers(token), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                private: true,       // never configurable — see the note on this class
                auto_init: false,
                description: 'Manuscript, backed up from Prose Studio.'
            })
        });

        if (res.status === 422) {
            throw new Error(`You already have a repository called "${name}". Pick a different name, or connect to the existing one.`);
        }
        if (!res.ok) throw new Error(await readError(res));

        const repo = await res.json();
        return {
            name: repo.name,
            owner: repo.owner?.login,
            fullName: repo.full_name,
            private: repo.private,
            empty: true,
            url: repo.html_url
        };
    }

    /**
     * A repository name GitHub will accept, derived from a story's folder name.
     *
     * Story folders are named by the writer — "The Quiet Coast" — and GitHub
     * allows only letters, digits, dots, hyphens and underscores.
     */
    suggestRepoName(story) {
        return String(story || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, '-')
            .replace(/^[-.]+|[-.]+$/g, '')
            .slice(0, 100) || 'manuscript';
    }
}

module.exports = new GitHubService();
