const crypto = require('crypto');

// Encryption for the handful of values that are genuinely secret: the Gemini
// API key and the GitHub token. Everything else is stored as written.
//
// The data files are encrypted as a whole now (services/db/fileCrypto.js), and
// these values are STILL encrypted individually inside them. That is not
// belt-and-braces for its own sake: a live credential is the one thing that is
// worth something to an attacker after it leaves the disk — in a log line, a
// crash dump, a support paste of a decrypted document. The file encryption
// protects the file; this protects the value.
//
// ## The key is derived when it is USED, not when this file is required
//
// It used to be derived at require time, from `process.env.SESSION_SECRET ||
// 'fallback-secret-for-dev-only'`. Both halves of that were a problem.
//
// The fallback is a constant in a public repository, so anything encrypted
// while SESSION_SECRET was unset was encrypted with a key anyone can read —
// which is not encryption, while looking exactly like it from every calling
// line. And because the value was captured at require time, whether that
// happened was decided by MODULE LOAD ORDER: any module that pulled this one in
// before the secret existed got the fallback and kept it for the life of the
// process.
//
// Deriving it per call costs one SHA-256 on an operation that runs once or
// twice a session, and the key file creates itself on demand, so there is no
// longer an ordering problem to get wrong.

const Vault = require('../services/config/Vault');

const IV_LENGTH = 16; // AES-256-CBC

function encryptionKey() {
    return Vault.fieldKey();
}

/** Returns `iv:ciphertext` in hex, or null for an empty value. */
function encrypt(text) {
    if (!text) return null;

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);

    return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Returns the plaintext, or null if it cannot be recovered.
 *
 * Null rather than a throw: a key that will not decrypt (a changed
 * SESSION_SECRET, usually) should surface as "AI is not configured" and a
 * prompt to paste the key again, not as a crashed request.
 */
function decrypt(text) {
    if (!text) return null;

    const parts = String(text).split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const payload = Buffer.from(parts.join(':'), 'hex');

    try {
        const decipher = crypto.createDecipheriv('aes-256-cbc', encryptionKey(), iv);
        return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8');
    } catch (err) {
        console.error('[Encryption] Could not decrypt a stored credential:', err.message);
        return null;
    }
}

/** Whether a stored value is in encrypted form. Mirrors the schema's guard. */
function isEncrypted(value) {
    return typeof value === 'string' && /^[0-9a-f]{32}:[0-9a-f]+$/i.test(value);
}

module.exports = { encrypt, decrypt, isEncrypted };
