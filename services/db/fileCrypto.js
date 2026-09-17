// Whole-file encryption for the data store.
//
// The files hold accounts, settings, characters and notifications, and they now
// live in a folder the writer can pick up and carry — which is the point, but
// it also means the folder travels: onto a USB stick, into Dropbox, into a zip
// someone emails for support. Plain JSON in that folder is a password hash and
// an email address readable by anyone who opens it in Notepad.
//
// ## What this does and does not protect
//
// The key is not stored anywhere. It is unwrapped at sign-in by the writer's
// own password (see services/config/Vault.js) and held in memory only. That is
// what lets this folder be carried to another machine and still be worth
// encrypting: there is no key file to bring along, and none to leave behind.
//
// So this stops: a synced folder being readable, a support zip leaking a
// password hash, a copied install, a stick left in a library computer. It does
// not stop someone running as this user on this machine WHILE the app is
// unlocked — a program that can read its own data can be made to hand it over.
// That is the honest boundary, and it is worth having.
//
// ## Lose the password and the recovery code, and the data is gone
//
// There is no third way in. That is what encryption is, and it is acceptable
// HERE for exactly one reason: the manuscript is not in these files. Chapters
// are Markdown on disk under the story root, untouched by any of this. The
// worst case is a writer who has to sign up again and re-paste an API key —
// never a lost word of the book.
//
// ## AES-256-GCM, not CBC
//
// GCM authenticates: a truncated, corrupted or edited file fails to decrypt
// instead of producing plausible garbage. That matters more here than the
// cipher does, because the caller's next move after a successful read is to
// write the file back — so silent garbage would overwrite the real data. CBC
// would have given us that failure mode for free.

const crypto = require('crypto');

// Marks a file as ours, and versions the format so a future change can be
// recognised rather than guessed at. Files that do not start with this are
// treated as legacy plaintext JSON and re-encrypted on the next write.
const MAGIC = Buffer.from('PENG1\n', 'utf8');
const IV_LENGTH = 12;   // GCM standard
const TAG_LENGTH = 16;

// A separate key from the one utils/encryption.js derives for API keys, so the
// two layers cannot be confused for each other. The API key inside this file
// stays individually encrypted too — the file being encrypted is not a reason
// to stop protecting the one value that is a live credential.
const storeKey = () => require('../config/Vault').storeKey();

/** True if this buffer is one of our encrypted files. */
function isEncrypted(buffer) {
    return Buffer.isBuffer(buffer) && buffer.length > MAGIC.length && buffer.subarray(0, MAGIC.length).equals(MAGIC);
}

/** Text in, encrypted buffer out. */
function seal(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', storeKey(), iv);
    const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);

    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

/**
 * Encrypted buffer in, text out. Throws if the file has been tampered with or
 * the key is wrong — the caller must treat that as "do not touch this file",
 * never as "start empty".
 */
function open(buffer) {
    if (!isEncrypted(buffer)) {
        throw new Error('Not an encrypted Prose Engine data file.');
    }

    const iv = buffer.subarray(MAGIC.length, MAGIC.length + IV_LENGTH);
    const tag = buffer.subarray(MAGIC.length + IV_LENGTH, MAGIC.length + IV_LENGTH + TAG_LENGTH);
    const body = buffer.subarray(MAGIC.length + IV_LENGTH + TAG_LENGTH);

    const decipher = crypto.createDecipheriv('aes-256-gcm', storeKey(), iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

module.exports = { seal, open, isEncrypted, MAGIC };
