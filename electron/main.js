// The desktop app: a window, a menu, and the engine running inside it.
//
// Prose Engine has always been a local server with a browser front end, which
// is a fine way to build it and a terrible way to ship it to a novelist. This
// file is the difference between "install Node, open a terminal, run npm, then
// type a URL" and "double-click Prose Engine".
//
// Nothing about the app changes in here. The same server boots, the same pages
// load, and if you open http://localhost:3100 in Chrome while this is running
// you get the same studio. That is deliberate: the desktop build is packaging,
// not a fork, and anything that behaves differently here would be a second
// implementation to keep honest.

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const APP_DIR = path.join(__dirname, '..');

// --- Where this installation keeps its data ---------------------------------
//
// This has to be decided BEFORE the server is required, because the store reads
// it as it loads. The packaged app cannot use its own directory the way the
// source tree does: __dirname is inside app.asar, which is read-only.
//
// Portable first, as promised in the README — the data sits beside the
// executable, so the whole app is one folder you can carry or delete. An
// installed copy under Program Files cannot write there, and falls back to the
// per-user application-data folder rather than failing to save.
function resolveDataLocations() {
    // An explicit setting wins over everything. It is how a writer keeps their
    // work on a second drive, how a portable build is pointed at its stick, and
    // how the tests run against a temp folder instead of someone's real data.
    if (process.env.PROSE_DATA_DIR) {
        const dataDir = path.resolve(process.env.PROSE_DATA_DIR);
        return {
            dataDir,
            configFile: process.env.PROSE_CONFIG_FILE
                ? path.resolve(process.env.PROSE_CONFIG_FILE)
                : path.join(path.dirname(dataDir), 'config.json'),
            portable: true
        };
    }

    /*
     * Beside the executable ONLY for the portable build.
     *
     * This used to be "beside the exe whenever that folder is writable", which
     * was wrong in a way that would have cost somebody their settings. The
     * installer is per-user, so it installs into %LOCALAPPDATA%\Programs — a
     * folder this app CAN write to. Data would have gone in there, inside the
     * installation, where an uninstall or an upgrade is entitled to delete it.
     * The writer would have reinstalled to get the new version and found their
     * account and API key gone.
     *
     * PORTABLE_EXECUTABLE_DIR is set by electron-builder's portable target and
     * by nothing else, so it is the honest way to tell "I am a single file the
     * writer carries" from "I am installed". Installed builds keep their data
     * in the user's own folder, which no installer touches.
     */
    if (process.env.PORTABLE_EXECUTABLE_DIR) {
        const beside = process.env.PORTABLE_EXECUTABLE_DIR;
        try {
            fs.mkdirSync(path.join(beside, 'data'), { recursive: true });
            const probe = path.join(beside, 'data', '.write-test');
            fs.writeFileSync(probe, '1');
            fs.unlinkSync(probe);
            return { dataDir: path.join(beside, 'data'), configFile: path.join(beside, 'config.json'), portable: true };
        } catch {
            // A stick that is full or read-only: fall through to the user folder
            // rather than refusing to start.
        }
    }

    if (!app.isPackaged) {
        return { dataDir: path.join(APP_DIR, 'data'), configFile: path.join(APP_DIR, 'config.json'), portable: true };
    }

    const userData = app.getPath('userData');
    return { dataDir: path.join(userData, 'data'), configFile: path.join(userData, 'config.json'), portable: false };
}

const locations = resolveDataLocations();
process.env.PROSE_DATA_DIR = locations.dataDir;
process.env.PROSE_CONFIG_FILE = locations.configFile;

// Two copies of the app writing the same files is a corruption you cannot
// undo. The second launch hands focus to the first and exits.
if (!app.requestSingleInstanceLock()) {
    app.quit();
    process.exit(0);
}

let mainWindow = null;
let serverPort = null;

/**
 * Waits for the server to answer, rather than guessing at a delay.
 *
 * Anything is a good answer here — a redirect to /setup or /login is what a
 * healthy first run gives. What is being waited on is "the socket is listening
 * and Express is responding", not any particular page.
 */
function waitForServer(port, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;

    return new Promise((resolve, reject) => {
        const attempt = () => {
            const req = http.get({ host: '127.0.0.1', port, path: '/login', timeout: 2000 }, (res) => {
                res.resume();
                resolve();
            });

            req.on('error', () => {
                if (Date.now() > deadline) return reject(new Error('The engine did not start in time.'));
                setTimeout(attempt, 200);
            });
            req.on('timeout', () => { req.destroy(); });
        };

        attempt();
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1360,
        height: 900,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: '#eef2f6',   // the studio's light background, so the
                                      // first frame is not a white flash
        show: false,
        title: 'Prose Engine',
        // Only needed when running from source: a packaged build takes its icon
        // from the executable, which electron-builder stamps from the same file.
        icon: path.join(APP_DIR, 'build', 'icon.png'),
        webPreferences: {
            // The page is our own server, but there is no reason for it to have
            // Node in reach: everything it needs comes over HTTP, exactly as it
            // does in a browser.
            nodeIntegration: false,
            contextIsolation: true,
            spellcheck: true
        }
    });

    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('closed', () => { mainWindow = null; });

    // A link to anywhere but this app opens in the writer's real browser. A
    // research link swallowed by a window with no address bar is a dead end.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith(`http://127.0.0.1:${serverPort}`) && !url.startsWith(`http://localhost:${serverPort}`)) {
            event.preventDefault();
            shell.openExternal(url);
        }
    });

    return mainWindow;
}

function buildMenu() {
    const template = [
        {
            label: 'File',
            submenu: [
                {
                    label: 'Open Data Folder',
                    click: () => shell.openPath(locations.dataDir)
                },
                {
                    label: 'Where Is Everything?',
                    click: showLocations
                },
                { type: 'separator' },
                { role: 'quit', label: 'Quit Prose Engine' }
            ]
        },
        {
            // Without an Edit menu, Ctrl+C and Ctrl+V do nothing in an Electron
            // window. In a writing app that is not a missing menu, it is a
            // broken application.
            label: 'Edit',
            submenu: [
                { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
                { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
                { role: 'selectAll' }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { type: 'separator' },
                // Writers read for hours. Being able to make the type bigger is
                // not a developer convenience.
                { role: 'resetZoom', label: 'Actual Size' },
                { role: 'zoomIn', label: 'Bigger Text' },
                { role: 'zoomOut', label: 'Smaller Text' },
                { type: 'separator' },
                { role: 'togglefullscreen' }
            ]
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: 'About Prose Engine',
                    click: () => dialog.showMessageBox(mainWindow, {
                        type: 'info',
                        title: 'Prose Engine',
                        message: `Prose Engine ${app.getVersion()}`,
                        detail: 'A writing desk that runs on your own computer.\n\n' +
                                'Your chapters are plain Markdown files in the story folder you chose. ' +
                                'They are never locked and never uploaded.'
                    })
                },
                {
                    label: 'Developer Tools',
                    accelerator: 'F12',
                    click: () => mainWindow && mainWindow.webContents.toggleDevTools()
                }
            ]
        }
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Answers the question the README has to answer in prose: where did this app
 * put my things, and what do I delete to be rid of it?
 */
function showLocations() {
    const Vault = require(path.join(APP_DIR, 'services/config/Vault.js'));

    dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Where Prose Engine keeps things',
        message: locations.portable
            ? 'Everything is in one folder.'
            : 'Prose Engine keeps its data in your user folder.',
        detail:
            `Settings and accounts (encrypted):\n${locations.dataDir}\n\n` +
            `Settings file:\n${locations.configFile}\n\n` +
            'Your manuscripts:\nthe story folder you chose in Settings — Prose Engine ' +
            'never deletes it, and uninstalling does not touch it.\n\n' +
            (locations.portable
                ? 'To remove Prose Engine completely, delete its folder.'
                : 'To remove Prose Engine completely, uninstall it and delete the folder above.'),
        buttons: ['Close', 'Open Data Folder'],
        defaultId: 0
    }).then(({ response }) => {
        if (response === 1) shell.openPath(locations.dataDir);
    });
}

function showStartupFailure(err) {
    dialog.showErrorBox(
        'Prose Engine could not start',
        `${err.message}\n\n` +
        `It was trying to use this folder for its data:\n${locations.dataDir}\n\n` +
        'If that folder is on a drive that is disconnected, or one this account cannot ' +
        'write to, that is the most likely cause.'
    );
    app.quit();
}

app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
});

app.whenReady().then(async () => {
    try {
        // Requiring the server starts it listening. Config has to be read after
        // PROSE_CONFIG_FILE is set above, which is why this require is here
        // rather than at the top of the file.
        const Config = require(path.join(APP_DIR, 'services/config/Config.js'));

        // Read it explicitly so the file is written on first run. Reaching it
        // only through port() would skip that whenever PORT is set in the
        // environment, and the writer would have no settings file to open.
        Config.load();
        serverPort = Config.port();

        require(path.join(APP_DIR, 'server.js'));
        await waitForServer(serverPort);

        buildMenu();
        createWindow();
        await mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);
    } catch (err) {
        showStartupFailure(err);
    }
});

// Windows and Linux: closing the window closes the app. A writing app that
// lingers invisibly in the tray after you close it would keep the data folder
// unlocked and in use, which is the opposite of what closing it should mean.
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverPort) {
        createWindow();
        mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);
    }
});

/**
 * Flush before the process goes.
 *
 * The store writes atomically and every save is awaited, but a save that is
 * still in flight when the window closes has to be allowed to land — otherwise
 * the last thing a writer changed before quitting is the thing they lose.
 */
let flushed = false;
app.on('before-quit', (event) => {
    if (flushed) return;

    event.preventDefault();
    const Database = require(path.join(APP_DIR, 'services/DatabaseService.js'));

    Database.close()
        .catch(err => console.error('[Shutdown] Flush failed:', err.message))
        .finally(() => { flushed = true; app.quit(); });
});
