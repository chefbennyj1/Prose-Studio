// Owns the MongoDB connection, including the case the rest of the app used to
// assume away: there is no database yet.
//
// The engine now boots whether or not Mongo answers. When it doesn't, the setup
// wizard (/setup) collects a connection string, proves it works, creates the
// database and its collections, and writes MONGODB_URI to .env — all without a
// restart, because writeEnv also updates process.env in place.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');

const ENV_PATH = path.join(__dirname, '..', '.env');
const MODELS_DIR = path.join(__dirname, '..', 'models');

const DEFAULT_URI = 'mongodb://localhost:27017/ProseEngine';

// The comic server's database. Both apps still share most of their schema, so
// pointing the Engine here means two apps writing each other's Series, Volumes
// and Users. Editing .env by hand still gets you there if you really mean it.
const RESERVED_DB_NAMES = ['veilsite'];

const CONNECT_OPTIONS = {
    serverSelectionTimeoutMS: 10000,
    heartbeatFrequencyMS: 10000,
    socketTimeoutMS: 45000
};

/** The URI the engine will use on this boot. */
exports.configuredUri = () => process.env.MONGODB_URI || DEFAULT_URI;

/** Whether MONGODB_URI was chosen deliberately or is just the built-in default. */
exports.uriIsExplicit = () => Boolean(process.env.MONGODB_URI);

exports.defaultUri = DEFAULT_URI;

exports.isConnected = () => mongoose.connection.readyState === 1;

/** Database name from a connection string, or '' if the URI names no database. */
function databaseNameFrom(uri) {
    try {
        return new URL(uri).pathname.replace(/^\//, '').trim();
    } catch {
        return '';
    }
}
exports.databaseNameFrom = databaseNameFrom;

/**
 * Shape checks that are worth doing before spending ten seconds on a timeout.
 * Returns null when the URI is usable, or a message explaining why it isn't.
 */
function validateUri(uri) {
    if (!uri || typeof uri !== 'string' || !uri.trim()) {
        return 'A connection string is required.';
    }
    if (!/^mongodb(\+srv)?:\/\//.test(uri.trim())) {
        return 'Connection string must start with mongodb:// or mongodb+srv://';
    }

    const dbName = databaseNameFrom(uri.trim());
    if (!dbName) {
        return 'Connection string must name a database, e.g. mongodb://localhost:27017/ProseEngine';
    }
    if (RESERVED_DB_NAMES.includes(dbName.toLowerCase())) {
        return `'${dbName}' is the comic server's database. The two apps share most of their ` +
               `schema, so they would overwrite each other's Series, Volumes and Users. Pick another name.`;
    }
    return null;
}
exports.validateUri = validateUri;

/**
 * Pings a URI on a throwaway client, so a failed attempt leaves the app's own
 * connection (which may be serving requests) untouched.
 */
exports.testConnection = async (uri) => {
    const invalid = validateUri(uri);
    if (invalid) return { ok: false, message: invalid };

    const client = new mongoose.mongo.MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    try {
        await client.connect();
        await client.db().command({ ping: 1 });
        return { ok: true, database: databaseNameFrom(uri) };
    } catch (err) {
        return { ok: false, message: err.message };
    } finally {
        await client.close().catch(() => {});
    }
};

/** Points the app's mongoose connection at a URI, replacing any existing one. */
exports.connect = async (uri) => {
    const invalid = validateUri(uri);
    if (invalid) return { ok: false, message: invalid };

    try {
        if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect();
        }
        await mongoose.connect(uri, CONNECT_OPTIONS);
        return { ok: true, database: databaseNameFrom(uri) };
    } catch (err) {
        return { ok: false, message: err.message };
    }
};

/**
 * MongoDB creates a database lazily, on first write — so a "connected" engine
 * with an empty database still has nothing in it. Materialise every model's
 * collection and build its indexes, so the database exists on disk and the
 * unique constraints are in place before the first document lands.
 */
exports.initialise = async () => {
    // Models register themselves on require; load them all rather than relying
    // on whichever ones the route tree happened to pull in.
    for (const file of fs.readdirSync(MODELS_DIR)) {
        if (file.endsWith('.js')) require(path.join(MODELS_DIR, file));
    }

    const db = mongoose.connection.db;
    const present = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name);
    const created = [];

    for (const model of Object.values(mongoose.models)) {
        const name = model.collection.collectionName;
        if (!present.includes(name)) {
            await db.createCollection(name);
            created.push(name);
        }
        // createIndexes, not syncIndexes: this must never drop an index that
        // someone added outside the schema.
        await model.createIndexes().catch(err => {
            console.warn(`[Database] Index build failed for ${name}: ${err.message}`);
        });
    }

    if (created.length) {
        console.log(`[Database] Created ${created.length} collections: ${created.join(', ')}`);
    }
    return created;
};

/**
 * Legacy: the Gemini settings lived under `vision`, from when they configured
 * panel-image description for the comic server. The only consumer left is the
 * prose critic, so the field was renamed — carry the saved key and model over
 * rather than making the writer paste their API key again.
 */
exports.runLegacyCriticMigration = async () => {
    try {
        const GlobalSettings = require('../models/GlobalSettings.js');
        const raw = await GlobalSettings.collection.findOne({ key: 'main' });
        if (!raw?.vision) return;

        const update = { $unset: { vision: '' } };
        if (!raw.critic) {
            update.$set = {
                critic: {
                    enabled: Boolean(raw.vision.enabled),
                    apiKey: raw.vision.apiKey || '',
                    modelName: raw.vision.modelName || 'gemini-flash-latest'
                }
            };
        }

        await GlobalSettings.collection.updateOne({ key: 'main' }, update);
        console.log("[Migration] Moved Gemini settings from 'vision' to 'critic'.");
    } catch (err) {
        console.error('[Migration] Error moving Gemini settings:', err);
    }
};

/** Legacy: users predating the role field carried `administrator: true`. */
exports.runLegacyRoleMigration = async () => {
    try {
        const User = require('../models/User.js');
        const result = await User.updateMany(
            { administrator: { $exists: true } },
            [
                { $set: { role: { $cond: { if: { $eq: ["$administrator", true] }, then: "admin", else: "$role" } } } },
                { $unset: "administrator" }
            ]
        );
        if (result.modifiedCount > 0) {
            console.log(`[Migration] Processed ${result.modifiedCount} users: migrated 'administrator' to 'role' and removed legacy field.`);
        }
    } catch (err) {
        console.error("[Migration] Error updating roles:", err);
    }
};

/**
 * Upserts keys into .env, preserving every other line, and mirrors them into
 * process.env so the running server picks them up without a restart.
 */
exports.writeEnv = (values) => {
    const existing = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    const lines = existing ? existing.split(/\r?\n/) : [];

    for (const [key, value] of Object.entries(values)) {
        const index = lines.findIndex(line => line.startsWith(`${key}=`));
        if (index >= 0) {
            lines[index] = `${key}=${value}`;
        } else {
            lines.push(`${key}=${value}`);
        }
        process.env[key] = value;
    }

    fs.writeFileSync(ENV_PATH, lines.join('\n').replace(/\n*$/, '\n'), 'utf8');
};

/**
 * A fresh clone has no .env at all. SESSION_SECRET missing makes express-session
 * throw on the first request; INTERNAL_EXPORT_SECRET missing used to be worse —
 * see middleware/auth.js. Generate whatever is absent.
 */
exports.ensureSecrets = () => {
    const generated = {};
    for (const key of ['SESSION_SECRET', 'INTERNAL_EXPORT_SECRET']) {
        if (!process.env[key]) generated[key] = crypto.randomBytes(32).toString('hex');
    }
    if (Object.keys(generated).length) {
        exports.writeEnv(generated);
        console.log(`[Setup] Generated ${Object.keys(generated).join(' and ')} into .env`);
    }
    return Object.keys(generated);
};
