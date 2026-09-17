// First-run wizard. One step now: create the admin who will run the engine.
//
// It used to be two, and the first was "paste a MongoDB connection string".
// That step is gone with the database server itself — the data store is a
// folder in the writer's app-data directory, created on boot — and removing it
// is most of the point of that work. The first thing a novelist saw when they
// opened this app was a form asking for a database URI, which is a question
// about somebody else's job.
//
// There is no self-registration in the Engine — /accounts/request only files a
// request and every approval route sits behind isAdmin. With an empty users
// collection that is a closed loop, and this is the only door out of it. The
// step refuses to run once the engine is set up, so the door closes behind you.

const bcrypt = require('bcryptjs');

const Database = require('../services/DatabaseService.js');
const Vault = require('../services/config/Vault.js');
const UserModel = require('../models/User.js');
const { validateAccountFields, normaliseEmail } = require('../utils/accountValidation.js');

// Guards the gap between "no users" and "user created" against a double submit.
let creatingFirstAdmin = false;

/**
 * Whether an account exists — asked WITHOUT reading the user collection.
 *
 * It used to count users, and that is no longer possible at the moment it is
 * needed: the user records are inside the encrypted store, and the store is
 * locked until somebody signs in. So the question is asked of the lock instead.
 * The lock is created by the first account and never removed, which makes
 * "there is a lock" and "there is an account" the same fact.
 */
function isSetupComplete() {
    return Vault.exists();
}

/** Counts users. Only valid once unlocked; used after sign-in. */
async function hasAnyUser() {
    if (!Database.isConnected() || !Vault.isUnlocked()) return false;
    try {
        return (await UserModel.estimatedDocumentCount()) > 0;
    } catch (err) {
        console.error('[Setup] User count failed:', err.message);
        return false;
    }
}
exports.isSetupComplete = isSetupComplete;

// --- GET /setup ---
exports.getSetup = async (req, res) => {
    if (isSetupComplete()) return res.redirect('/login');
    res.render('setup/index');
};

// --- GET /setup/status ---
// Drives what the wizard shows, so a refresh mid-setup resumes.
//
// `storeReady` is kept in the payload even though there is no step that fixes
// it. If the app-data folder is not writable, account creation will fail, and a
// wizard that knows that can say so up front instead of letting the writer fill
// in a form that cannot be submitted.
exports.getStatus = async (req, res) => {
    res.json({
        ok: true,
        storeReady: Database.isConnected(),
        storeDirectory: Database.directory(),
        locked: !Vault.isUnlocked(),
        hasUsers: isSetupComplete(),
        complete: isSetupComplete()
    });
};

// --- POST /setup/admin ---
//
// This is also where the data folder gets its lock, and the order matters: the
// vault is created FIRST, because until it exists there is no key and the user
// record cannot be written at all.
exports.createFirstAdmin = async (req, res) => {
    if (isSetupComplete()) {
        return res.status(409).json({ ok: false, message: 'An account already exists. Sign in instead.' });
    }
    if (!Database.isConnected()) {
        return res.status(500).json({
            ok: false,
            message: `Prose Engine cannot write to its data folder (${Database.directory()}), ` +
                     `so the account could not be saved. Check that folder's permissions, or set ` +
                     `PROSE_DATA_DIR to somewhere writable, and restart.`
        });
    }
    if (creatingFirstAdmin) {
        return res.status(409).json({ ok: false, message: 'That account is already being created.' });
    }

    const { username, email, password, confirmPassword } = req.body;

    const error = validateAccountFields({ username, email, password, confirmPassword });
    if (error) return res.status(400).json({ ok: false, message: error });

    creatingFirstAdmin = true;
    try {
        // Re-read rather than trusting the check above: another wizard tab could
        // have won the race between it and this write.
        if (isSetupComplete()) {
            return res.status(409).json({ ok: false, message: 'An account already exists. Sign in instead.' });
        }

        // Locks the data folder with this password and leaves it open for the
        // rest of this session.
        const { recoveryCode } = await Vault.create(password);

        const user = await UserModel.create({
            username: username.trim(),
            email: normaliseEmail(email),
            password: await bcrypt.hash(password, 12),
            role: 'admin'
        });

        console.log(`[Setup] First admin created: ${user.username} <${user.email}>`);

        return res.json({
            ok: true,
            message: `Admin account created for ${user.username}.`,
            // Shown once, never stored in a form anyone can read back. It is the
            // only way into this data if the password is forgotten, so the
            // wizard must make the writer stop and keep it.
            recoveryCode,
            redirect: '/login'
        });
    } catch (err) {
        console.error('[Setup] createFirstAdmin error:', err);
        return res.status(500).json({ ok: false, message: `Could not create the account: ${err.message}` });
    } finally {
        creatingFirstAdmin = false;
    }
};

/**
 * Express middleware, guarding the two states in which most of the app cannot
 * work yet.
 *
 * NO ACCOUNT — nothing exists, so everything but the wizard is a dead end. Say
 * so rather than redirecting to a login form nobody can pass.
 *
 * LOCKED — an account exists but nobody has signed in, so the data folder
 * cannot be read at all. Only the sign-in page and the sign-in request get
 * through; every other route would throw the moment it touched a model, and
 * "the data store is locked" is a much worse thing for a writer to meet than
 * the login form they were going to need anyway.
 *
 * The check is deliberately cheap and does not read anything: one file test for
 * the lock, one boolean for the key. It runs on every request.
 */
exports.setupGate = async (req, res, next) => {
    const wantsJson = req.xhr || req.originalUrl.startsWith('/api');

    if (!isSetupComplete()) {
        if (wantsJson) {
            return res.status(503).json({ ok: false, message: 'Prose Engine is not set up yet. Open /setup.' });
        }
        return res.redirect('/setup');
    }

    if (!Vault.isUnlocked()) {
        const signingIn = req.path === '/login' || req.path.startsWith('/authentication');
        if (signingIn) return next();

        if (wantsJson) {
            return res.status(401).json({
                ok: false,
                locked: true,
                message: 'Prose Engine is locked. Sign in to open your work.'
            });
        }
        return res.redirect('/login');
    }

    return next();
};
