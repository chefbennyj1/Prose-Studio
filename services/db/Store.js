// Where the documents actually live: one encrypted file per collection, in a
// folder the writer can carry, copy or delete.
//
// This replaces MongoDB, and the reason is the writer, not the engineering. A
// novelist cannot be asked to install and run a database server before they can
// open a chapter — "start mongod" is not a sentence that belongs in a writing
// app. Everything Mongo was holding here is configuration and a handful of
// records (accounts, settings, characters, notifications); the manuscript
// itself has always been Markdown files on disk and still is. That is small
// enough that a file per collection, held in memory, is not a compromise.
//
// Deliberately pure JavaScript, with no native module. SQLite would be a better
// database and the wrong dependency: native bindings must be rebuilt for every
// Electron version and architecture shipped, and that is the step that breaks
// installers on other people's machines.
//
// ## Portable by default
//
// The folder is `data/` next to the application, not a hidden corner of the
// system, so the whole app is one directory: copy it to a USB stick and it
// comes with you, delete it and Prose Engine is gone with nothing left behind.
// That is a promise to the writer as much as a layout choice — an uninstall
// nobody has to trust.
//
// App-data is the FALLBACK, for an install under Program Files or anywhere else
// the app's own folder is read-only. A portable app that silently fails to save
// would be far worse than one that quietly keeps its data elsewhere and says so
// in the log.
//
// ## Encrypted, with no extension
//
// The files have no `.json` on them and their contents are AES-256-GCM (see
// fileCrypto.js). A portable folder is one that travels, and plain JSON in it
// is an email address and a password hash that open in Notepad.
//
// The key lives in the app's .env, NOT in this folder, which is what makes the
// encryption mean anything when the folder is synced or shared. It also means
// losing .env loses this data permanently — acceptable only because the
// manuscript is not in here, and it is worth re-reading fileCrypto.js before
// ever putting prose in one of these files.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const fileCrypto = require('./fileCrypto');

const APP_ROOT = path.join(__dirname, '..', '..');

/** The per-user application-data folder for this platform. */
function systemDataDir() {
    const home = os.homedir();
    if (process.platform === 'win32') {
        return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Prose Engine', 'data');
    }
    if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'Prose Engine', 'data');
    }
    return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'prose-engine', 'data');
}

function canWriteTo(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, '.write-test');
        fs.writeFileSync(probe, '1', 'utf8');
        fs.unlinkSync(probe);
        return true;
    } catch {
        return false;
    }
}

/**
 * Portable first, app-data second, and PROSE_DATA_DIR over both — which is how
 * the tests point at a temp folder and how an installed copy can be told to
 * keep a writer's data somewhere specific.
 */
function defaultDataDir() {
    if (process.env.PROSE_DATA_DIR) return path.resolve(process.env.PROSE_DATA_DIR);

    const portable = path.join(APP_ROOT, 'data');
    if (canWriteTo(portable)) return portable;

    return systemDataDir();
}

/**
 * Refuses to touch a file while the store is locked.
 *
 * This runs BEFORE any read or write, and it is the guard that stops a locked
 * read from being mistaken for a damaged file. Without it, load() asked for the
 * key, got "locked", and took that for "this file will not decrypt" — so it
 * renamed the writer's data aside and carried on with an empty collection. A
 * plain read, with the correct password never having been typed, destroyed the
 * appearance of the data and the next save would have made it true.
 *
 * Required lazily: Vault reads `store.dir` from this module, so requiring it at
 * the top would be a cycle.
 */
function assertUnlocked() {
    const Vault = require('../config/Vault');
    if (Vault.isUnlocked()) return;

    const err = new Error(
        'The data store is locked. Prose Engine cannot read or write anything until someone ' +
        'signs in — their password is what opens it.'
    );
    err.code = 'LOCKED';
    throw err;
}

class Collection {
    constructor(name, dir) {
        this.name = name;
        // No extension, on purpose: the contents are not JSON once written, and
        // a `.json` that will not open in a JSON viewer is a worse lie than no
        // extension at all.
        this.file = path.join(dir, name);
        this.docs = null;        // null until loaded
        this.writing = Promise.resolve();
        this.dirty = false;
    }

    /**
     * Reads the file once, then serves from memory.
     *
     * A file that cannot be read is MOVED ASIDE, never overwritten, and the
     * difference between the two failures is reported because they need
     * different answers from a person:
     *
     *   - not decryptable — almost always a replaced .env, so the data is
     *     intact and the KEY is what was lost. Silently starting empty here
     *     would present as "the app forgot my account" and the next save would
     *     destroy the evidence.
     *   - not parseable — a half-written file from a machine that lost power.
     *
     * Either way the bytes are kept. A writer can be walked through a file that
     * still exists; nothing can be done about one we deleted.
     */
    load() {
        if (this.docs) return this.docs;

        assertUnlocked();

        let raw;
        try {
            raw = fs.readFileSync(this.file);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                this.setAside(`could not be read (${err.message})`);
            }
            this.docs = [];
            return this.docs;
        }

        let text;
        if (fileCrypto.isEncrypted(raw)) {
            try {
                text = fileCrypto.open(raw);
            } catch (err) {
                // Belt and braces: assertUnlocked() above should already have
                // stopped us, and if a locked state ever reaches here it must
                // still not be mistaken for a damaged file.
                if (err.code === 'LOCKED') throw err;

                this.setAside(
                    'could not be DECRYPTED. The data is intact but this installation no longer has ' +
                    `the key for it — that happens when the folder was written by a different account ` +
                    `or a different Prose Engine (${err.message})`
                );
                this.docs = [];
                return this.docs;
            }
        } else {
            // A file written before whole-file encryption. Read it as-is; the
            // next write seals it.
            text = raw.toString('utf8');
            console.log(`[Store] ${this.name} is unencrypted; it will be encrypted on the next save.`);
        }

        try {
            const parsed = JSON.parse(text);
            this.docs = Array.isArray(parsed) ? parsed : [];
        } catch (err) {
            this.setAside(`could not be parsed (${err.message})`);
            this.docs = [];
        }

        return this.docs;
    }

    /** Renames a file we refuse to use, so the bytes survive. */
    setAside(reason) {
        const aside = `${this.file}.unreadable-${Date.now()}`;
        try {
            fs.renameSync(this.file, aside);
            console.error(`[Store] '${this.name}' ${reason}.`);
            console.error(`[Store] The file has been kept as '${path.basename(aside)}' and '${this.name}' starts empty. Nothing was deleted.`);
        } catch (err) {
            console.error(`[Store] '${this.name}' ${reason}, and could not be moved aside: ${err.message}`);
        }
    }

    /**
     * Writes the whole collection, through a temp file and a rename.
     *
     * The rename is the point: it is atomic on every filesystem we run on, so a
     * crash mid-save leaves either the old file or the new one, never a
     * truncated file. Writes are chained rather than parallel so two saves in
     * the same tick cannot interleave, and every caller awaits the same chain —
     * which is what lets `save()` honestly mean "on disk".
     */
    flush() {
        assertUnlocked();

        this.dirty = true;
        this.writing = this.writing.then(async () => {
            if (!this.dirty) return;
            this.dirty = false;

            const temp = `${this.file}.${process.pid}.tmp`;
            await fsp.mkdir(path.dirname(this.file), { recursive: true });
            await fsp.writeFile(temp, fileCrypto.seal(JSON.stringify(this.docs ?? [], null, 2)));
            await fsp.rename(temp, this.file);
        }).catch(err => {
            console.error(`[Store] Failed to save ${this.name}: ${err.message}`);
        });

        return this.writing;
    }
}

class Store {
    constructor(dir) {
        this.dir = dir || defaultDataDir();
        this.collections = new Map();
    }

    /** Points the store at a different folder, dropping anything cached. */
    setDir(dir) {
        this.dir = path.resolve(dir);
        this.collections.clear();
    }

    collection(name) {
        let existing = this.collections.get(name);
        if (!existing) {
            existing = new Collection(name, this.dir);
            this.collections.set(name, existing);
        }
        return existing;
    }

    /** Whether the data folder sits inside the application's own directory. */
    isPortable() {
        return this.dir.startsWith(APP_ROOT);
    }

    /**
     * Collection files present on disk. Ignores the ones we set aside, and the
     * two files in here that are not collections: the lock, and config.json
     * when it has been pointed at this folder.
     */
    existingFiles() {
        const notCollections = new Set(['keywrap.json', 'config.json']);

        try {
            return fs.readdirSync(this.dir).filter(name =>
                !name.startsWith('.') &&
                !name.includes('.unreadable-') &&
                !name.endsWith('.tmp') &&
                !notCollections.has(name));
        } catch {
            return [];
        }
    }

    /** Waits for every pending write. Called on shutdown. */
    async drain() {
        await Promise.all([...this.collections.values()].map(c => c.writing));
    }
}

module.exports = new Store();
module.exports.Store = Store;
module.exports.defaultDataDir = defaultDataDir;
module.exports.systemDataDir = systemDataDir;
module.exports.APP_ROOT = APP_ROOT;
