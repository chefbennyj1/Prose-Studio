const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/**
 * DictionaryService
 *
 * The words this writer uses, and how they are said. One list, two questions.
 *
 * These used to be two stores that did not know about each other: a spelling
 * list of words to stop flagging, and a pronunciation list of words to say
 * differently. They were very nearly the same words - an invented name is
 * exactly the thing a spell checker does not recognise AND the thing a
 * narrator mispronounces - and keeping them apart cost more than the
 * duplication.
 *
 * It cost correctness, in fact. The two were keyed differently: "add to
 * dictionary" wrote under a leftover comic-era series id while the spell check
 * sent no key at all and read an empty list, so a word added to the dictionary
 * went on being reported as unknown for ever. One store with one key cannot
 * have that bug.
 *
 * TWO LAYERS, because words belong to different things:
 *
 *   GLOBAL   how this writer spells. "realise", "grey", their own habits.
 *            Follows them into every book; retyping it per story is silly.
 *   STORY    what this book invented. "Silas", "Kaethe", the name of a ship.
 *            A character in one manuscript is a typo in another, so these do
 *            NOT leak between stories.
 *
 * Story wins where both name the same word: the book in front of you is more
 * specific than a habit.
 *
 * An entry is `{ spoken }`, and spoken is optional. A word with no spoken is
 * simply "this is a word" - the spell checker stops flagging it and the
 * narrator says it however it reads. Adding a pronunciation later does not
 * change its spelling status, which is the point of merging them.
 */

const DIR = path.join(__dirname, '..', '..', 'dictionaries');

/**
 * A story folder can never start with a dot (Storage.SAFE_SEGMENT forbids it),
 * so this name cannot collide with a real story's file.
 */
const GLOBAL_FILE = '.global.json';

const SCOPES = ['global', 'story'];

/** Same guard the story paths use: a key, never a path. */
function fileFor(scope, story) {
    if (scope === 'global') return path.join(DIR, GLOBAL_FILE);
    const safe = String(story || '').replace(/[^a-z0-9_ -]/gi, '_').trim();
    if (!safe) throw new Error('Open a story first.');
    return path.join(DIR, `${safe}.json`);
}

/**
 * Older shapes, read transparently so nothing a writer typed is lost:
 *   - an array of words, which is what the spelling list used to be
 *   - a bare {word: spoken} map, which is what the pronunciation list was
 */
function normalise(parsed) {
    if (Array.isArray(parsed)) {
        return Object.fromEntries(parsed.filter(w => typeof w === 'string').map(w => [w, {}]));
    }
    if (!parsed || typeof parsed !== 'object') return {};

    const out = {};
    for (const [word, value] of Object.entries(parsed)) {
        if (typeof value === 'string') out[word] = value ? { spoken: value } : {};
        else if (value && typeof value === 'object') out[word] = value.spoken ? { spoken: value.spoken } : {};
        else out[word] = {};
    }
    return out;
}

async function readFile(file) {
    try {
        return normalise(JSON.parse(await fsp.readFile(file, 'utf8')));
    } catch (err) {
        // Absent is the normal case. An unreadable one must not stop the
        // narrator or the spell checker: a missing dictionary is a worse
        // reading, not a broken feature.
        if (err.code !== 'ENOENT') {
            console.error(`[DictionaryService] Could not read ${path.basename(file)}:`, err.message);
        }
        return {};
    }
}

async function writeFile(file, entries) {
    await fsp.mkdir(DIR, { recursive: true });
    const sorted = Object.fromEntries(
        Object.entries(entries).sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    );
    await fsp.writeFile(file, JSON.stringify(sorted, null, 2), 'utf8');
}

/**
 * Folds the two pre-merge files into this one, once.
 *
 * `<story>.pronunciation.json` is merged into that story's list. The old
 * `default.json` is a special case: it was written under a comic-era key that
 * names no story anybody would recognise, so its words go to GLOBAL rather
 * than being stranded under a story that does not exist. Both originals are
 * renamed rather than deleted - this runs unattended and should not be the
 * last word on somebody's word list.
 */
let absorbed = false;

async function absorbLegacy() {
    if (absorbed) return;
    absorbed = true;

    try {
        const names = await fsp.readdir(DIR);

        for (const name of names.filter(n => n.endsWith('.pronunciation.json'))) {
            const story = name.slice(0, -'.pronunciation.json'.length);
            const from = path.join(DIR, name);
            const target = fileFor('story', story);

            const merged = { ...(await readFile(target)), ...(await readFile(from)) };
            await writeFile(target, merged);
            await fsp.rename(from, `${from}.migrated`);
            console.log(`[DictionaryService] Folded ${name} into ${story}'s dictionary.`);
        }

        if (names.includes('default.json')) {
            const from = path.join(DIR, 'default.json');
            const merged = { ...(await readFile(fileFor('global'))), ...(await readFile(from)) };
            await writeFile(fileFor('global'), merged);
            await fsp.rename(from, `${from}.migrated`);
            console.log('[DictionaryService] Moved the old default dictionary into the global list.');
        }
    } catch (err) {
        if (err.code !== 'ENOENT') console.error('[DictionaryService] Migration skipped:', err.message);
    }
}

class DictionaryService {

    /** @returns {Promise<{global: object, story: object}>} both layers, unmerged */
    async layers(story) {
        await absorbLegacy();
        const [globalWords, storyWords] = await Promise.all([
            readFile(fileFor('global')),
            story ? readFile(fileFor('story', story)) : Promise.resolve({})
        ]);
        return { global: globalWords, story: storyWords };
    }

    /** Both layers flattened, story winning. What the checker and voice see. */
    async merged(story) {
        const { global: g, story: s } = await this.layers(story);
        return { ...g, ...s };
    }

    /** Every known word, for seeding the spell checker. */
    async words(story) {
        return Object.keys(await this.merged(story));
    }

    /** word -> respelling, for the narrator. Only entries that have one. */
    async lexicon(story) {
        const out = {};
        for (const [word, entry] of Object.entries(await this.merged(story))) {
            if (entry.spoken) out[word] = entry.spoken;
        }
        return out;
    }

    /**
     * Adds or updates one word.
     *
     * @param {'global'|'story'} scope
     * @param {string} spoken  optional respelling; '' clears it but KEEPS the
     *                         word, because "this is a word" and "say it like
     *                         this" are separate facts and clearing one must
     *                         not silently discard the other.
     */
    async set(scope, story, word, spoken = '') {
        if (!SCOPES.includes(scope)) throw new Error('Unknown dictionary scope.');

        const key = String(word || '').trim();
        if (!key) throw new Error('Give the word you want to add.');
        if (/\s/.test(key)) throw new Error('One word at a time.');

        const file = fileFor(scope, story);
        const entries = await readFile(file);
        const say = String(spoken || '').trim();

        entries[key] = say ? { spoken: say } : {};
        await writeFile(file, entries);
        return this.layers(story);
    }

    /** Removes a word entirely - both its spelling status and its respelling. */
    async remove(scope, story, word) {
        if (!SCOPES.includes(scope)) throw new Error('Unknown dictionary scope.');

        const file = fileFor(scope, story);
        const entries = await readFile(file);
        delete entries[String(word || '').trim()];
        await writeFile(file, entries);
        return this.layers(story);
    }

    /** Moves a word between the global and story lists. */
    async move(fromScope, story, word) {
        const toScope = fromScope === 'global' ? 'story' : 'global';
        const { [fromScope === 'global' ? 'global' : 'story']: source } = await this.layers(story);
        const entry = source[word] || {};

        await this.set(toScope, story, word, entry.spoken || '');
        return this.remove(fromScope, story, word);
    }
}

module.exports = new DictionaryService();
