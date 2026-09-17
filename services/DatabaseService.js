// Owns the local data store: where it lives, whether it is usable, and the
// secrets the app needs before it can encrypt anything.
//
// This used to own a MongoDB connection — a URI, a ten-second connection
// timeout, a reachability test, and a setup wizard step whose whole job was to
// get a writer through "install MongoDB, start mongod, paste a connection
// string". None of that survives, because none of it was ever about writing a
// novel. The documents are JSON files in the user's app-data folder now (see
// services/db/Store.js), so "connecting" is: make sure the folder exists and
// can be written to.
//
// The manuscript is untouched by any of this. Chapters are Markdown files under
// the writer's chosen story root, and always have been.

const fs = require('fs');
const path = require('path');


const db = require('./db');
const store = require('./db/Store');


const MODELS_DIR = path.join(__dirname, '..', 'models');

/** Where the data files live on this machine. */
exports.directory = () => store.dir;

exports.isConnected = () => db.connection.readyState === 1;

/**
 * Makes the data folder usable and marks the store open.
 *
 * Returns the same `{ ok, message }` shape the Mongo version did, because the
 * callers branch on it — but the failures are different in kind. There is no
 * network, no auth and no timeout; the only way this fails is a folder that
 * cannot be created or cannot be written to, which is a permissions or a
 * full-disk problem, and the message says so.
 */
exports.connect = async (dir) => {
    const target = dir ? path.resolve(dir) : store.dir;

    try {
        fs.mkdirSync(target, { recursive: true });

        // Prove it is writable now, rather than discovering it on the first
        // save — which would be the moment the writer creates their account.
        const probe = path.join(target, '.write-test');
        fs.writeFileSync(probe, String(Date.now()), 'utf8');
        fs.unlinkSync(probe);
    } catch (err) {
        return {
            ok: false,
            message: `Cannot write to ${target}: ${err.message}`,
            directory: target
        };
    }

    db.open(target);
    return { ok: true, directory: target };
};

/**
 * Loads every model so the registry is complete.
 *
 * Mongo needed this to materialise collections and build indexes before the
 * first write. Here there is nothing to create — a collection file appears when
 * something is saved into it — but the models still have to be REQUIRED, or a
 * populate() for a model no route has pulled in yet would find nothing in the
 * registry. Same reason as before, different mechanism.
 */
exports.initialise = async () => {
    for (const file of fs.readdirSync(MODELS_DIR)) {
        if (file.endsWith('.js')) require(path.join(MODELS_DIR, file));
    }

    const existing = store.existingFiles();
    console.log(`[Store] ${store.dir} (${existing.length} collection${existing.length === 1 ? '' : 's'} on disk)`);
    return existing;
};

// writeEnv() and ensureSecrets() lived here and are gone with .env itself.
// Settings are config.json (services/config/Config.js) and the secrets are
// derived from the writer's password at sign-in (services/config/Vault.js) —
// there is no longer a file of generated secrets for anything to maintain.

/** Flushes pending writes. Called on shutdown. */
exports.close = async () => {
    await store.drain();
};
