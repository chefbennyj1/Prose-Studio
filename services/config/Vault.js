// The lock on the data folder, opened by the writer's own password.
//
// This is what makes the folder both PORTABLE and SECURE, which no file-based
// key can be at once. A key stored anywhere travels with whatever it is stored
// beside: put it in the data folder and syncing the folder hands over the key;
// put it beside the app and copying the app hands it over; put it in the user
// profile and the folder no longer opens on another machine. The only key that
// can travel safely is one that was never written down — so the key comes from
// the writer, and the folder can go anywhere.
//
// ## The password does not encrypt anything
//
// It unwraps a random 32-byte DATA KEY, which is what actually encrypts the
// files. The indirection buys three things, and each of them would otherwise be
// a wart:
//
//   - changing a password rewraps one small key instead of re-encrypting every
//     file in the folder
//   - several accounts can open the same folder, each with its own wrap of the
//     same data key, without knowing each other's passwords
//   - a RECOVERY CODE is just another wrap, so "I forgot my password" stops
//     being the end of the data
//
// ## Unwrapping is authentication
//
// AES-GCM is authenticated: with the wrong key it fails rather than returning
// wrong bytes. So a successful unwrap PROVES the password, which is what
// resolves the chicken-and-egg — the user records live inside the encrypted
// store, so we cannot read them to check a password before we can decrypt.
// bcrypt still guards the account record for everything else; this is what
// opens the door before there is anything to read.
//
// ## What it does not do
//
// Every account unwraps the SAME data key, so any account that can sign in can
// decrypt the whole folder. For one writer's studio that is the right shape —
// it is a lock on the folder, not a wall between colleagues.
//
// And once unlocked, the key is in this process's memory, where anything
// running as that user could reach it. A program that can read its own data can
// be made to hand it over; that is the boundary of what any of this can promise.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const store = require('../db/Store');

// The wrap file is the one thing in the data folder that is NOT encrypted — it
// is what you must be able to read in order to decrypt everything else. It
// holds no secret: a salt, the KDF's cost parameters, and a key sealed with a
// password nobody has written down.
const WRAP_FILE = 'keywrap.json';

// scrypt, sized so a wrong guess is expensive and a real login is not. ~100ms
// on a normal laptop; N is the cost, and it is recorded per entry so it can be
// raised later without stranding folders written under the old number.
const KDF = { N: 2 ** 16, r: 8, p: 1, keylen: 32 };

let dataKey = null;   // in memory only, from unlock() until lock()

// Work that cannot run until the store is readable — the manuscript watcher is
// the one that matters, because it needs the story root out of encrypted
// settings. Before this, it started at boot; now it starts at first sign-in.
const unlockListeners = [];

function onUnlock(listener) {
    unlockListeners.push(listener);
    if (dataKey) listener();
}

function announceUnlock() {
    for (const listener of unlockListeners) {
        try {
            listener();
        } catch (err) {
            console.error(`[Vault] An unlock listener failed: ${err.message}`);
        }
    }
}

function wrapPath() {
    return path.join(store.dir, WRAP_FILE);
}

function readWrapFile() {
    try {
        return JSON.parse(fs.readFileSync(wrapPath(), 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw new Error(`The lock file at ${wrapPath()} could not be read: ${err.message}`);
    }
}

function writeWrapFile(contents) {
    fs.mkdirSync(store.dir, { recursive: true });
    const temp = `${wrapPath()}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, wrapPath());
}

function derive(password, salt, params = KDF) {
    return new Promise((resolve, reject) => {
        // maxmem must be raised to match N, or scrypt refuses its own settings.
        const options = { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r };
        crypto.scrypt(String(password), Buffer.from(salt, 'hex'), params.keylen, options,
            (err, key) => (err ? reject(err) : resolve(key)));
    });
}

function seal(key, plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
        iv: iv.toString('hex'),
        tag: cipher.getAuthTag().toString('hex'),
        body: body.toString('hex')
    };
}

function open(key, sealed) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(sealed.body, 'hex')), decipher.final()]);
}

/** Builds one entry: the data key, sealed under a secret. */
async function makeEntry(label, secret, key) {
    const salt = crypto.randomBytes(16).toString('hex');
    const wrappingKey = await derive(secret, salt, KDF);

    return {
        label,                       // 'password' or 'recovery' — never a username
        salt,
        kdf: { N: KDF.N, r: KDF.r, p: KDF.p, keylen: KDF.keylen },
        wrapped: seal(wrappingKey, key)
    };
}

/** Whether this folder has been set up with a lock at all. */
function exists() {
    return Boolean(readWrapFile());
}

function isUnlocked() {
    return dataKey !== null;
}

/**
 * The key everything else encrypts with. Throws rather than returning null,
 * because every caller is about to read or write real data and "locked" is a
 * bug at that point, not a value to handle.
 */
function key() {
    if (!dataKey) {
        const err = new Error(
            'The data store is locked. Prose Engine cannot read or write anything until ' +
            'someone signs in — their password is what opens it.'
        );
        // Tagged so the store can tell "no key yet" apart from "this file will
        // not decrypt". They look identical at the cipher and they could not be
        // more different: one is a normal state, the other means the data is
        // unreadable. Treating the first as the second moved a writer's file
        // aside and started empty — on a plain read. See services/db/Store.js.
        err.code = 'LOCKED';
        throw err;
    }
    return dataKey;
}

/**
 * Creates the lock, with the first account's password and a recovery code.
 *
 * The recovery code is returned ONCE and never stored in a form we can read. It
 * is the difference between a forgotten password costing a writer their
 * settings and costing them nothing.
 */
async function create(password) {
    if (exists()) throw new Error('This data folder already has a lock on it.');

    const key = crypto.randomBytes(32);

    // Grouped for reading aloud and typing back in, which is what it is for.
    const recoveryCode = crypto.randomBytes(20).toString('base64url')
        .replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 24)
        .match(/.{1,4}/g).join('-');

    writeWrapFile({
        version: 1,
        note: 'This file is the lock on the data in this folder. It contains no readable secret. ' +
              'Deleting it makes the other files in this folder permanently unreadable.',
        entries: [
            await makeEntry('password', password, key),
            await makeEntry('recovery', recoveryCode, key)
        ]
    });

    dataKey = key;
    announceUnlock();
    return { recoveryCode };
}

/**
 * Tries a secret against every entry.
 *
 * Every entry is tried rather than looking one up by name, and the entries are
 * labelled by KIND rather than by account, so the lock file never becomes a
 * list of who has an account here. Trying a handful of scrypt entries costs a
 * few hundred milliseconds at sign-in, which is the one moment in this app
 * where nobody notices.
 */
async function unlock(secret) {
    const file = readWrapFile();
    if (!file) return false;

    for (const entry of file.entries) {
        try {
            const wrappingKey = await derive(secret, entry.salt, entry.kdf);
            const opened = open(wrappingKey, entry.wrapped);
            dataKey = opened;
            announceUnlock();
            return true;
        } catch {
            // Wrong secret for this entry. GCM failing is the expected path.
        }
    }

    return false;
}

/** Forgets the key. The folder is unreadable again until someone signs in. */
function lock() {
    dataKey = null;
}

/**
 * Whether a secret opens the lock, WITHOUT unlocking or changing anything.
 *
 * This exists for accounts that were created without their password ever
 * passing through here — approving a sign-up request copies a bcrypt hash, and
 * a hash cannot wrap a key. Such an account can pass bcrypt but not the lock,
 * so the sign-in path uses this to notice and enrol them. See
 * authentication/authentication.js.
 */
async function canOpen(secret) {
    const file = readWrapFile();
    if (!file) return false;

    for (const entry of file.entries) {
        try {
            const wrappingKey = await derive(secret, entry.salt, entry.kdf);
            open(wrappingKey, entry.wrapped);
            return true;
        } catch { /* not this entry */ }
    }

    return false;
}

/**
 * Adds or replaces a password entry, using the key we already hold.
 *
 * This is why an admin can reset someone's password without knowing the old
 * one: they are signed in, so the data key is in memory, and a new wrap can be
 * made for the new password. It is also how a password CHANGE works, without
 * touching a single encrypted file.
 */
async function addPassword(password) {
    const file = readWrapFile();
    if (!file) throw new Error('This data folder has no lock to add a password to.');

    file.entries.push(await makeEntry('password', password, key()));
    writeWrapFile(file);
}

/**
 * Replaces one password entry with another, proving the old password first.
 * Returns false if the old password does not open the lock.
 */
async function changePassword(oldPassword, newPassword) {
    const file = readWrapFile();
    if (!file) throw new Error('This data folder has no lock.');

    for (let index = 0; index < file.entries.length; index++) {
        const entry = file.entries[index];
        if (entry.label !== 'password') continue;

        try {
            const wrappingKey = await derive(oldPassword, entry.salt, entry.kdf);
            const opened = open(wrappingKey, entry.wrapped);
            file.entries[index] = await makeEntry('password', newPassword, opened);
            writeWrapFile(file);
            dataKey = opened;
            return true;
        } catch {
            // Not this entry.
        }
    }

    return false;
}

/**
 * The forgot-password path: a recovery code opens the lock and a new password
 * is enrolled against the same data key.
 *
 * Note what is NOT done — the forgotten password's entry is not removed,
 * because there is no way to tell which entry it was without the password
 * itself. It is harmless: it unlocks a folder whose accounts it can no longer
 * sign into, and it is a password nobody can remember by definition.
 *
 * The recovery code is rotated on use. A code that has been typed into a
 * screen, read off a printout or pasted into a chat has been out in the world,
 * and it is the one credential here that cannot be changed by its owner.
 */
async function recover(recoveryCode, newPassword) {
    if (!await unlock(recoveryCode)) return { ok: false };

    await addPassword(newPassword);
    const { recoveryCode: replacement } = await resetRecoveryCode();

    return { ok: true, recoveryCode: replacement };
}

/** Issues a fresh recovery code, replacing any existing one. */
async function resetRecoveryCode() {
    const file = readWrapFile();
    if (!file) throw new Error('This data folder has no lock.');

    const recoveryCode = crypto.randomBytes(20).toString('base64url')
        .replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 24)
        .match(/.{1,4}/g).join('-');

    file.entries = file.entries.filter(entry => entry.label !== 'recovery');
    file.entries.push(await makeEntry('recovery', recoveryCode, key()));
    writeWrapFile(file);

    return { recoveryCode };
}

/** A key for `label`, derived from the data key. Same pattern as the old file. */
function keyFor(label) {
    return crypto.createHash('sha256').update(Buffer.concat([key(), Buffer.from(`:${label}`)])).digest();
}

module.exports = {
    exists,
    isUnlocked,
    onUnlock,
    key,
    keyFor,
    create,
    unlock,
    lock,
    addPassword,
    changePassword,
    canOpen,
    recover,
    resetRecoveryCode,
    wrapPath,

    /** Encrypts the data files. See services/db/fileCrypto.js. */
    storeKey: () => keyFor('store-v1'),

    /** Encrypts individual stored credentials. See utils/encryption.js. */
    fieldKey: () => keyFor('field-v1'),

    /** Signs session cookies. */
    sessionSecret: () => keyFor('session').toString('hex'),

    /** Guards the internal export route. See middleware/auth.js. */
    exportSecret: () => keyFor('internal-export').toString('hex')
};
