// The database, as far as the rest of the app is concerned.
//
// This module is a drop-in for the slice of mongoose this codebase used, and it
// is shaped that way on purpose. The alternative — a clean new data API — would
// have meant rewriting twenty controllers and services to change where the data
// sits, and every one of those files is a chance to break a feature that had
// nothing to do with this work. Swapping one `require` line per model is a
// change you can read in a diff and reason about.
//
// What actually changed for the user: there is no database server any more.
// `mongod` does not have to be installed, running, or reachable, and a writer
// who has never heard of MongoDB can open the app and start a chapter.
//
// The manuscript was never in here. Chapters are Markdown files on disk and
// still are; this holds accounts, settings, characters and notifications.

const path = require('path');

const store = require('./Store');
const ObjectId = require('./ObjectId');
const Schema = require('./Schema');
const { createModel, registry, ValidationError } = require('./Model');

/**
 * Mongoose keeps a connection state; several callers still ask for it before
 * doing work. There is no connection to make, but "ready" has to mean something
 * honest, so it means: the data folder has been established and is writable.
 */
const connection = {
    readyState: 0,
    on() { return connection; },
    once() { return connection; },
    off() { return connection; },
    async close() { await store.drain(); connection.readyState = 0; },
    get db() { return null; },
    getClient() { return null; }
};

function model(name, schema, collectionName) {
    if (!schema) {
        const existing = registry.get(name);
        if (!existing) throw new Error(`[db] Model '${name}' has not been registered.`);
        return existing;
    }

    // Requiring a model twice must not build it twice, or two halves of the app
    // would hold different objects for the same collection.
    if (registry.has(name)) return registry.get(name);

    const built = createModel(name, schema, collectionName);
    registry.set(name, built);
    return built;
}

const models = new Proxy({}, {
    get: (_, name) => registry.get(name),
    has: (_, name) => registry.has(name),
    ownKeys: () => [...registry.keys()],
    getOwnPropertyDescriptor: (_, name) => registry.has(name)
        ? { enumerable: true, configurable: true, value: registry.get(name) }
        : undefined
});

module.exports = {
    Schema,
    model,
    models,
    connection,

    Types: { ObjectId },
    isValidObjectId: ObjectId.isValid,

    /** Points the store at a folder and marks the engine ready. */
    open(dir) {
        if (dir) store.setDir(dir);
        connection.readyState = 1;
        return { ok: true, directory: store.dir };
    },

    /** Where the data files live, for the setup screen and for support. */
    get directory() { return store.dir; },

    store,
    registry,
    ValidationError,
    ObjectId,
    dataFileFor: (collectionName) => path.join(store.dir, `${collectionName}.json`)
};
