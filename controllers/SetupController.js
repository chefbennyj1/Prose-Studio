// First-run wizard. Two steps, in order: point the engine at a database, then
// create the admin who will run it.
//
// There is no self-registration in the Engine — /accounts/request only files a
// request and every approval route sits behind isAdmin. With an empty users
// collection that is a closed loop, and this is the only door out of it. Both
// steps refuse to run once the engine is set up, so the door closes behind you.

const bcrypt = require('bcryptjs');

const Database = require('../services/DatabaseService.js');
const UserModel = require('../models/User.js');
const { validateAccountFields, normaliseEmail } = require('../utils/accountValidation.js');

// Latches true and never goes back: once an admin exists, the wizard is over.
// Checked on every request until it flips, which is cheap and only during setup.
let setupComplete = false;

// Guards the gap between "no users" and "user created" against a double submit.
let creatingFirstAdmin = false;

async function hasAnyUser() {
    if (!Database.isConnected()) return false;
    try {
        return (await UserModel.estimatedDocumentCount()) > 0;
    } catch (err) {
        console.error('[Setup] User count failed:', err.message);
        return false;
    }
}

/** True once the engine has both a database and someone who can log into it. */
async function isSetupComplete() {
    if (setupComplete) return true;
    setupComplete = Database.isConnected() && await hasAnyUser();
    return setupComplete;
}
exports.isSetupComplete = isSetupComplete;

// --- GET /setup ---
exports.getSetup = async (req, res) => {
    if (await isSetupComplete()) return res.redirect('/login');
    res.render('setup/index');
};

// --- GET /setup/status ---
// Drives which step the wizard opens on, so a refresh mid-setup resumes.
exports.getStatus = async (req, res) => {
    const connected = Database.isConnected();
    res.json({
        ok: true,
        dbConnected: connected,
        dbName: connected ? Database.databaseNameFrom(Database.configuredUri()) : null,
        suggestedUri: Database.configuredUri(),
        hasUsers: await hasAnyUser(),
        complete: await isSetupComplete()
    });
};

// --- POST /setup/database ---
exports.configureDatabase = async (req, res) => {
    if (await isSetupComplete()) {
        return res.status(409).json({ ok: false, message: 'The engine is already set up. Sign in to change settings.' });
    }

    const uri = String(req.body.uri || '').trim();

    const invalid = Database.validateUri(uri);
    if (invalid) return res.status(400).json({ ok: false, message: invalid });

    const test = await Database.testConnection(uri);
    if (!test.ok) {
        return res.status(400).json({ ok: false, message: `Could not reach that database: ${test.message}` });
    }

    const connected = await Database.connect(uri);
    if (!connected.ok) {
        return res.status(500).json({ ok: false, message: `Connection failed: ${connected.message}` });
    }

    try {
        const created = await Database.initialise();
        await Database.runLegacyRoleMigration();
        await Database.runLegacyCriticMigration();
        Database.writeEnv({ MONGODB_URI: uri });
        Database.ensureSecrets();

        // An existing database may already have accounts — in which case the
        // wizard is done and the admin step would be wrong to offer.
        const usersPresent = await hasAnyUser();

        return res.json({
            ok: true,
            database: connected.database,
            collectionsCreated: created.length,
            hasUsers: usersPresent,
            message: created.length
                ? `Created database '${connected.database}' with ${created.length} collections.`
                : `Connected to existing database '${connected.database}'.`
        });
    } catch (err) {
        console.error('[Setup] Database initialisation failed:', err);
        return res.status(500).json({ ok: false, message: `Database initialisation failed: ${err.message}` });
    }
};

// --- POST /setup/admin ---
exports.createFirstAdmin = async (req, res) => {
    if (await isSetupComplete()) {
        return res.status(409).json({ ok: false, message: 'An account already exists. Sign in instead.' });
    }
    if (!Database.isConnected()) {
        return res.status(400).json({ ok: false, message: 'Connect a database first.' });
    }
    if (creatingFirstAdmin) {
        return res.status(409).json({ ok: false, message: 'That account is already being created.' });
    }

    const { username, email, password, confirmPassword } = req.body;

    const error = validateAccountFields({ username, email, password, confirmPassword });
    if (error) return res.status(400).json({ ok: false, message: error });

    creatingFirstAdmin = true;
    try {
        // Re-read rather than trusting the latch: another wizard tab could have
        // won the race between the check above and this write.
        if (await hasAnyUser()) {
            return res.status(409).json({ ok: false, message: 'An account already exists. Sign in instead.' });
        }

        const user = await UserModel.create({
            username: username.trim(),
            email: normaliseEmail(email),
            password: await bcrypt.hash(password, 12),
            role: 'admin'
        });

        setupComplete = true;
        console.log(`[Setup] First admin created: ${user.username} <${user.email}>`);

        return res.json({
            ok: true,
            message: `Admin account created for ${user.username}.`,
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
 * Express middleware. Until the engine has a database and an admin, everything
 * that isn't the wizard is a dead end — say so instead of redirecting to a
 * login form nobody can pass.
 */
exports.setupGate = async (req, res, next) => {
    if (await isSetupComplete()) return next();

    if (req.xhr || req.originalUrl.startsWith('/api')) {
        return res.status(503).json({ ok: false, message: 'Prose Engine is not set up yet. Open /setup.' });
    }
    res.redirect('/setup');
};
