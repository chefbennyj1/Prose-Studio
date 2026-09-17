// Application settings, as readable JSON.
//
// This is the other half of removing .env. Everything that was a KEY=value line
// and is not secret lives here instead, in a file a person can open, read and
// edit without being told about environment variables, shell exports or why
// their editor saved it as `.env.txt`.
//
// It sits beside the application rather than in the data folder, because the
// data folder is encrypted and portable: a config file in there could not be
// edited by hand, which is the entire reason it is JSON.
//
// Settings the WRITER changes — the story root, the AI key, GitHub — are not
// here. Those belong to the account and live in the data store, where the
// dashboard can edit them. This file is for settings the machine has: which
// port to serve on, and whether images go to cloud storage.

const fs = require('fs');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = process.env.PROSE_CONFIG_FILE
    ? path.resolve(process.env.PROSE_CONFIG_FILE)
    : path.join(APP_ROOT, 'config.json');

// 3000 belongs to the comic server; the two are routinely run side by side.
const DEFAULTS = {
    port: 3100,
    cloudStorage: {
        enabled: false,
        bucketName: '',
        baseUrl: ''
    }
};

let cached = null;

function merge(defaults, loaded) {
    const result = { ...defaults };

    for (const [key, value] of Object.entries(loaded || {})) {
        if (value !== null && typeof value === 'object' && !Array.isArray(value) && defaults[key]) {
            result[key] = merge(defaults[key], value);
        } else if (value !== undefined) {
            result[key] = value;
        }
    }

    return result;
}

/**
 * Reads config.json, writing a commented default on first run.
 *
 * A file that will not parse is reported and IGNORED rather than replaced: it
 * is a file a human edits, so a stray comma is the likeliest failure, and
 * overwriting their edit is a worse answer than starting from defaults and
 * saying so.
 */
function load() {
    if (cached) return cached;

    let onDisk = null;

    try {
        onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') {
            cached = { ...DEFAULTS };
            save(cached);
            console.log(`[Config] Created ${CONFIG_PATH}`);
            return cached;
        }
        console.error(`[Config] ${CONFIG_PATH} could not be read (${err.message}).`);
        console.error('[Config] Using defaults for this run. The file has not been changed — fix the JSON and restart.');
        cached = { ...DEFAULTS };
        return cached;
    }

    cached = merge(DEFAULTS, onDisk);
    return cached;
}

function save(values) {
    const merged = merge(DEFAULTS, values);
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    cached = merged;
    return cached;
}

module.exports = {
    path: CONFIG_PATH,
    load,
    save,

    /** The port to serve on. PORT still wins, for a one-off run. */
    port: () => Number(process.env.PORT) || load().port || DEFAULTS.port,

    /** Shape the dashboard expects in `res.locals.config`. */
    cloudStorage: () => {
        const { cloudStorage } = load();
        return {
            useCloudStorage: Boolean(cloudStorage.enabled),
            gcsBucketName: cloudStorage.bucketName,
            gcsBaseUrl: cloudStorage.baseUrl
        };
    },

    /** Forgets the cached file. Tests only. */
    reset: () => { cached = null; }
};
