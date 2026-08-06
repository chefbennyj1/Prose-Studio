// Server Entry Point
require('dotenv').config();
const express = require('express'); //server
const bcrypt = require('bcryptjs'); //password encryption
const path = require('path'); //files paths
const session = require('express-session'); //current session data
const { MongoStore } = require('connect-mongo'); // New robust DB session store (v6 named export)
const mongoose = require('mongoose'); //DB interface
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
  
  socket.on('disconnect', () => {
    console.log(`WebSocket client disconnected: ${socket.id}`);
  });
});

// The connection itself lives in DatabaseService, because the engine now has to
// boot without one: a fresh install has no database until /setup makes it.
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

// --- CONNECTION EVENT LISTENERS ---
mongoose.connection.on('error', err => {
  console.error('[MongoDB] connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.warn('[MongoDB] disconnected. Attempting to reconnect...');
});

mongoose.connection.on('reconnected', () => {
  console.log('[MongoDB] reconnected');
});

// Handle graceful shutdown
const gracefulShutdown = async (signal) => {
  console.log(`[${signal}] Shutting down gracefully...`);
  try {
    await mongoose.connection.close();
    console.log('MongoDB connection closed.');
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Sessions are stored in Mongo, so the middleware can only be built once there
// is a Mongo to store them in. It is created on the first request that gets
// past the setup gate — by which point the connection is known good.
let sessionMiddleware = null;

function getSessionMiddleware() {
  if (sessionMiddleware) return sessionMiddleware;

  sessionMiddleware = session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      client: mongoose.connection.getClient(),
      collectionName: 'ProseSessions',
      ttl: 24 * 60 * 60, // 24 hours
      autoRemove: 'native',
      crypto: {
        secret: process.env.SESSION_SECRET
      }
    }),
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
  res.locals.config = {
    useCloudStorage: process.env.USE_CLOUD_STORAGE === 'true',
    gcsBucketName: process.env.GCS_BUCKET_NAME,
    gcsBaseUrl: process.env.GCS_BASE_URL
  };

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

// 3000 belongs to the comic server; the two are routinely run side by side.
const PORT = process.env.PORT || 3100;
const SYSTEM_SECRET = crypto.randomBytes(32).toString('hex');
app.locals.systemSecret = SYSTEM_SECRET;
console.log('[System] Generated runtime API secret for internal plugins.');

// Plugin System
const PluginLoader = require('./services/PluginLoader');
PluginLoader.loadAll(app, { port: PORT, systemSecret: SYSTEM_SECRET });

app.use("/", siteRoutes);


// Connect if we can, then listen either way. A failed connection is not fatal
// any more — it is the state /setup exists to fix.
(async () => {
  const hostname = getLocalIPv4();
  const uri = Database.configuredUri();

  const result = await Database.connect(uri);

  if (result.ok) {
    console.log(`mongoDb Connected (${result.database})`);
    await Database.initialise();
    await Database.runLegacyRoleMigration();
    await Database.runLegacyCriticMigration();
    Database.ensureSecrets();

    // Live updates when a chapter changes on disk. Follows the story root if
    // it is repointed in Settings.
    const ManuscriptWatcher = require('./services/manuscript/ManuscriptWatcher.js');
    const Storage = require('./services/StorageService.js');
    await ManuscriptWatcher.start(io);
    Storage.onRootChange(() => ManuscriptWatcher.start(io));
  } else {
    console.warn(`[Database] Could not reach ${uri}: ${result.message}`);
    console.warn(`[Setup] Open http://${hostname}:${PORT}/setup to point the engine at a database.`);
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
