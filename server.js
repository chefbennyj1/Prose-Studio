// Server Entry Point
//
// There is no dotenv and no .env. Settings are config.json (services/config/
// Config.js) and the one secret is a key file in the user's profile
// (services/config/Secrets.js), both of which create themselves on first run —
// so a fresh clone starts with no setup file to copy and nothing to export.
const express = require('express'); //server
const bcrypt = require('bcryptjs'); //password encryption
const path = require('path'); //files paths
const session = require('express-session'); //current session data
const SessionStore = require('./services/db/SessionStore.js'); //sessions, stored as a local file
const Config = require('./services/config/Config.js'); //config.json, replaces .env
const Vault = require('./services/config/Vault.js'); //the password-unlocked data key
const fs = require('fs'); //file system
const mime = require('mime-types'); //ensure proper mime types
const sharp = require('sharp'); //image editing
const os = require('os');

const crypto = require("crypto");
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Make io accessible to our routers/controllers
app.locals.io = io;

io.on('connection', (socket) => {
  console.log(`WebSocket client connected: ${socket.id}`);

  // A page that loads (or reconnects after a sleep) has no idea whether the
  // filesystem watch behind live updates is actually running. Tell it, rather
  // than leaving it to infer from an editor that has quietly stopped noticing
  // anything.
  try {
    const ManuscriptWatcher = require('./services/manuscript/ManuscriptWatcher.js');
    socket.emit('manuscript:watcher', ManuscriptWatcher.status());
  } catch { /* watcher not loaded yet; it announces itself when it starts */ }

  socket.on('disconnect', () => {
    console.log(`WebSocket client disconnected: ${socket.id}`);
  });
});

// The data store lives in DatabaseService. There is no database server any
// more: documents are JSON files in the user's app-data folder, so a fresh
// install has somewhere to write the moment the folder can be created.
const Database = require('./services/DatabaseService.js');

const siteRoutes = require("./routes/routes.js");
const setupRoutes = require("./routes/setup.js");
const authRoutes = require("./authentication/authentication.js");
const apiRoutes = require("./api/api.js");
const accountRoutes = require("./accounts/accounts.js");

const User = require("./models/User.js");
// updateVolumesFromFS is now exported from ./services/VolumeService.js
const { isAuth } = require('./middleware/auth.js');
const SetupController = require('./controllers/SetupController.js');

// Handle graceful shutdown.
//
// There is no connection to close, but there may be a write in flight: saves
// are atomic (temp file, then rename) and awaited, so what this waits for is
// the rename landing. Exiting without it is how the last thing a writer changed
// before quitting gets lost.
const gracefulShutdown = async (signal) => {
  console.log(`[${signal}] Shutting down gracefully...`);
  try {
    await Database.close();
    console.log('Data store flushed.');
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// The cookie signing secret is random per process, and that is not a shortcut.
//
// It cannot come from the vault, because the session middleware runs on the
// request that is trying to UNLOCK the vault — there is no key yet. And it does
// not need to survive a restart, because sessions do not either: the store is
// in memory now (see services/db/SessionStore.js), for the same reason. A
// restart means signing in again, which is the same act as unlocking.
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');

let sessionMiddleware = null;

function getSessionMiddleware() {
  if (sessionMiddleware) return sessionMiddleware;

  sessionMiddleware = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: new SessionStore({ ttl: 24 * 60 * 60 }), // 24 hours
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 // 24 hours
    }
  });

  return sessionMiddleware;
}

// --- MIDDLEWARE ---
//
// Order matters more than it used to. Everything above the setup gate has to
// work with no database at all; everything below it can assume one.

// 1. Body Parsing — the wizard posts JSON before a session store can exist
//
// The limit is raised well past express's 100kb default because the editor
// posts whole chapters: saving, spelling, the mechanics scan and the critic
// all send the manuscript in the request body. 100kb is roughly 17,000 words,
// so a long chapter silently crossed it and came back as a 413 — whose body is
// an HTML error page, which reaches the editor as "Unexpected token '<'"
// rather than as anything resembling "your chapter is too big".
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// 2. View Engine
app.set("views", path.join(__dirname, "views"));
app.engine("html", require("ejs").renderFile);
app.set("view engine", "ejs");

// 3. Static & Content Serving
app.use('/views', express.static(path.join(__dirname, 'views')));
app.use('/resources', express.static(path.join(__dirname, 'resources')));
app.use('/libs', express.static(path.join(__dirname, 'libs')));
app.use('/services/public', express.static(path.join(__dirname, 'services/public')));
app.use(express.static(path.join(__dirname, "views/public")));

// 4. First-run wizard — the only routes that work before the database does
app.use("/setup", setupRoutes);

// 5. Setup gate — no database or no accounts means there is nothing else to serve
app.use(SetupController.setupGate);

// 6. Session
app.use((req, res, next) => getSessionMiddleware()(req, res, next));

// 7. Global Locals (Config & User) - MUST BE BEFORE ROUTES
app.use(async (req, res, next) => {
  res.locals.config = Config.cloudStorage();

  res.locals.user = null;

  if (!req.session.userId) {
    return next();
  }

  try {
    res.locals.user = await User.findById(req.session.userId);
  } catch (e) {
    console.error("User lookup failed:", e);
  }

  next();
});

// --- ROUTES ---

app.get('/test-swarm', (req, res) => {
  res.render('test-swarm');
});

app.use("/api", apiRoutes);
app.use("/authentication", authRoutes);
app.use("/accounts", accountRoutes);

// From config.json, which the writer can edit; PORT still wins for a one-off run.
const PORT = Config.port();

// Publish the resolved port back into the environment.
//
// Services that call this server's own API - the suggestion scan and the local
// critic both poll the LLM plugin's status endpoint - read process.env.PORT and
// carry their own fallback. With no PORT set those fallbacks said 3000 while
// this said 3100, so every one of those calls went to a dead port, was
// swallowed by the retry loop, and surfaced two minutes later as "the local LLM
// engine did not become ready". Writing it back leaves one source of truth.
process.env.PORT = String(PORT);
// Guards /api/toast, which is how a process on this machine raises a toast in
// the dashboard without a user session.
const SYSTEM_SECRET = crypto.randomBytes(32).toString('hex');
app.locals.systemSecret = SYSTEM_SECRET;
console.log('[System] Generated runtime API secret.');

// The plugin system was loaded here. It existed to host a local llama.cpp
// engine and a proof-reader that depended on it, and both are gone: the AI is
// Gemini now, reached directly, and everything that runs without it - spelling,
// mechanics, the narrator - was never a plugin.

app.use("/", siteRoutes);


// Open the data store, then listen either way. A store that cannot be opened is
// a permissions or disk problem, not a missing server, so there is no wizard
// step that can fix it — the message has to name the folder and the reason.
(async () => {
  const hostname = getLocalIPv4();

  const result = await Database.connect();

  if (result.ok) {
    await Database.initialise();

    // Live updates when a chapter changes on disk, following the story root if
    // it is repointed in Settings.
    //
    // This waits for a sign-in, where it used to start at boot. It has to: the
    // story root is in the settings document, the settings document is
    // encrypted, and nothing can be decrypted until a password unlocks the
    // store. So the watcher starts on the first unlock instead — which is the
    // first moment there is anything for it to watch on behalf of.
    Vault.onUnlock(async () => {
      const ManuscriptWatcher = require('./services/manuscript/ManuscriptWatcher.js');
      const Storage = require('./services/StorageService.js');
      await ManuscriptWatcher.start(io);
      Storage.onRootChange(() => ManuscriptWatcher.start(io));
    });

    console.log(Vault.exists()
      ? '[Vault] Locked. Sign in to open the data store.'
      : '[Vault] No account yet — the first one created will lock this data folder.');
  } else {
    console.error(`[Store] ${result.message}`);
    console.error('[Store] Nothing can be saved until that folder is writable. ' +
                  'Set PROSE_DATA_DIR to somewhere this user can write, or fix the permissions on it.');
  }

  server.listen(PORT, () => {
    console.log(`Website running on http://${hostname}:${PORT}`);
    if (!result.ok) return;
    SetupController.isSetupComplete().then(complete => {
      if (!complete) console.log(`[Setup] No accounts yet — create the first admin at http://${hostname}:${PORT}/setup`);
    });
  });
})();

function getLocalIPv4() {
  const interfaces = os.networkInterfaces();
  const allAddrs = Object.values(interfaces).flat();
  const ipv4 = allAddrs.find(
    (iface) => iface.family === 'IPv4' && !iface.internal
  );
  return ipv4 ? ipv4.address : 'localhost';
}

// --- GLOBAL ERROR HANDLERS ---
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err.stack || err);
});
