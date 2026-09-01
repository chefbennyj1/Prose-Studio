// API ENDPOINTS
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();

console.log('[API] Initializing API routes...');

// Controllers
const UserController = require('../controllers/UserController.js');
const VolumeController = require('../controllers/VolumeController.js');
const LibraryController = require('../controllers/LibraryController.js');
const CharacterController = require('../controllers/CharacterController.js');
const CriticController = require('../controllers/CriticController.js');
const SiteController = require('../controllers/SiteController.js');

// Editor Controllers
const PageDataController = require('../controllers/PageDataController.js');
const PageStructureController = require('../controllers/PageStructureController.js');
const SystemSettingsController = require('../controllers/SystemSettingsController.js');

const { isAuthApi: isAuth, isModerator, isAdmin } = require('../middleware/auth.js');

// --- Multer: Character Avatar Upload ---
const avatarStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const charId = req.params.id;
        if (!charId) return cb(new Error('Character ID is required for upload'));
        const dir = path.join(__dirname, `../views/public/images/characters/${charId}/avatar`);
        const refDir = path.join(__dirname, `../views/public/images/characters/${charId}/references`);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(refDir)) fs.mkdirSync(refDir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, `avatar-${Date.now()}${path.extname(file.originalname)}`)
});
const uploadAvatar = multer({ storage: avatarStorage });

// --- Multer: Character Reference Image Upload ---
const referenceStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const charId = req.params.id;
        if (!charId) return cb(new Error('Character ID is required for upload'));
        const dir = path.join(__dirname, `../views/public/images/characters/${charId}/references`);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, `ref-${Date.now()}${path.extname(file.originalname)}`)
});
const uploadReference = multer({ storage: referenceStorage });

// --- Multer: User Avatar Upload ---
const userAvatarStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const userId = req.session.userId;
        if (!userId) return cb(new Error('Not authenticated'));
        const dir = path.join(__dirname, `../views/public/images/users/${userId}`);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, `avatar${path.extname(file.originalname).toLowerCase()}`)
});
const uploadUserAvatar = multer({
    storage: userAvatarStorage,
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
        allowed.includes(path.extname(file.originalname).toLowerCase())
            ? cb(null, true)
            : cb(new Error('Only image files are allowed.'));
    }
});

// --- TEST ROUTE ---
router.get('/test', (req, res) => res.json({ ok: true, message: "API is working" }));

// --- SYSTEM NOTIFICATIONS ---
// Secret-guarded rather than session-guarded: this is for a process on this
// machine, not a signed-in user.
router.all('/toast', (req, res) => {
    // Internal API Security: Validate the runtime secret
    const incomingSecret = req.headers['x-sequential-secret'];
    const systemSecret = req.app.locals.systemSecret;
    
    if (!systemSecret || incomingSecret !== systemSecret) {
        return res.status(403).json({ ok: false, message: "Unauthorized: Invalid or missing API Secret" });
    }
    
    const type = req.query.type || req.body.type || 'info';
    const header = req.query.header || req.body.header || 'Notification';
    const message = req.query.message || req.body.message || '';
    
    if (req.app.locals.io) {
        req.app.locals.io.emit('plugin_toast', { type, title: header, message });
    }
    
    res.json({ ok: true });
});

// The plugin routes stood here. They went with the plugin system itself, which
// existed to host a local llama.cpp engine and a proof-reader that depended on
// it. Both are gone; the AI is Gemini, reached directly.

// --- SYSTEM POWER (shutdown / restart from the dashboard) ---

// Boots a fresh server after this process exits. The delay lets the old
// process release port 3000 before the new one binds it.
function relaunchDetached() {
    const { spawn } = require('child_process');
    const nodePath = process.argv[0];
    const script = process.argv[1];
    if (process.platform === 'win32') {
        const command = `Start-Sleep -Seconds 2; & '${nodePath.replace(/'/g, "''")}' '${script.replace(/'/g, "''")}'`;
        spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', command],
            { detached: true, stdio: 'ignore', cwd: process.cwd() }).unref();
    } else {
        spawn('/bin/sh', ['-c', `sleep 2; "${nodePath}" "${script}"`],
            { detached: true, stdio: 'ignore', cwd: process.cwd() }).unref();
    }
}

// No shutdownAll() on either of these any more. It existed to kill the
// llama-server child process the LLM plugin spawned; nothing the server starts
// now outlives it.
router.post('/system/shutdown', isAdmin, (req, res) => {
    console.log('[System] Shutdown requested from the dashboard.');
    res.json({ ok: true, message: 'Server shutting down.' });
    setTimeout(() => process.exit(0), 500);
});

router.post('/system/restart', isAdmin, (req, res) => {
    console.log('[System] Restart requested from the dashboard.');
    res.json({ ok: true, message: 'Server restarting.' });
    relaunchDetached();
    setTimeout(() => process.exit(0), 500);
});

// --- NOTIFICATIONS ---
const NotificationController = require('../controllers/NotificationController.js');
router.get('/notifications', isAuth, (req, res) => NotificationController.list(req, res));
router.post('/notifications', isAuth, (req, res) => NotificationController.create(req, res));
router.delete('/notifications', isAuth, (req, res) => NotificationController.clearAll(req, res));
router.delete('/notifications/:id', isAuth, (req, res) => NotificationController.remove(req, res));

// --- SYSTEM SETTINGS ---
router.get('/settings/global', isAdmin, SystemSettingsController.getGlobalSettings);
router.put('/settings/global', isAdmin, SystemSettingsController.updateGlobalSettings);

// --- EDITOR ROUTES ---

// 1. Page Data (PageDataController)
router.post('/editor/sync-page/:series/:volumeId/:chapter/:pageId', isModerator, PageDataController.syncPage);
router.get('/editor/plot-board/:series', isModerator, PageDataController.getPlotBoard);
router.post('/editor/plot-board/:series', isModerator, PageDataController.savePlotBoard);


// 2. Page Structure & Scaffolding (PageStructureController)
router.get('/editor/next-page-id', isModerator, PageStructureController.getNextPageId);
router.get('/editor/chapter-range', isModerator, PageStructureController.getChapterRange);
router.post('/editor/create-page', isAdmin, PageStructureController.createPage);
router.post('/editor/insert-page', isAdmin, PageStructureController.insertPage);
router.post('/editor/reorder-pages', isAdmin, PageStructureController.reorderPages);
router.post('/editor/create-chapter', isAdmin, PageStructureController.createChapter);
router.post('/editor/insert-chapter', isAdmin, PageStructureController.insertChapter);

// --- CHARACTERS ---
router.get('/characters', isAuth, CharacterController.getAll);
router.get('/characters/:name', isAuth, CharacterController.getOne);
router.post('/characters', isAuth, CharacterController.create);
router.put('/characters/:id', isAuth, CharacterController.update);
router.delete('/characters/:id', isAuth, CharacterController.delete);
router.post('/characters/:id/avatar', isAuth, uploadAvatar.single('avatar'), (req, res) => CharacterController.uploadAvatar(req, res));
router.post('/characters/:id/reference', isAuth, uploadReference.single('image'), (req, res) => CharacterController.uploadReferenceImage(req, res));

// --- FONTS ---
router.get('/fonts', isAuth, SiteController.getAvailableFonts);

// --- STORAGE (where stories live on disk) ---
// Names carry spaces and dots, so they travel as query/body values rather than
// path segments — no encoding surprises between the editor and the filesystem.
const StorageController = require('../controllers/StorageController.js');
router.get('/storage/root',    isAuth,  StorageController.getRoot);
router.put('/storage/root',    isAdmin, StorageController.setRoot);
router.get('/storage/browse',  isAdmin, StorageController.browse);
router.post('/storage/folder', isAdmin, StorageController.createFolder);

// --- MANUSCRIPT (one markdown file per chapter, under the story root) ---
// Pages are computed from word count, never stored, so there is no page route.
const ManuscriptController = require('../controllers/ManuscriptController.js');
router.get('/manuscript/stories',   isAuth, ManuscriptController.listStories);
router.post('/manuscript/story',    isAuth, ManuscriptController.createStory);
router.get('/manuscript/chapters',  isAuth, ManuscriptController.listChapters);
router.post('/manuscript/chapter',  isAuth, ManuscriptController.createChapter);
router.get('/manuscript/read',      isAuth, ManuscriptController.readChapter);
// Read only. There is deliberately no replace beside it - see SearchService.
router.post('/manuscript/search',   isAuth, ManuscriptController.searchStory);
router.post('/manuscript/save',     isAuth, ManuscriptController.saveChapter);

// --- PROOFING (spelling + local edit suggestions) ---
const ProofingController = require('../controllers/ProofingController.js');
// Datamuse. No key, no AI, works with everything switched off.
router.get('/proofing/thesaurus', isAuth, ProofingController.getThesaurus);
// Whole-novel word cloud, function words removed. Local, no AI.
router.get('/proofing/word-cloud', isAuth, ProofingController.getWordCloud);
router.get('/proofing/status', isAuth, ProofingController.getStatus);
router.post('/proofing/spell', isAuth, ProofingController.checkSpelling);
router.post('/proofing/scan', isAuth, ProofingController.scanOnComplete);

// Mechanics: punctuation, dialogue, grammar, layout. Hand-rolled rules rather
// than a model, so this one answers in milliseconds and costs nothing to run.
router.get('/proofing/mechanics/rules', isAuth, ProofingController.getMechanicsRules);
router.post('/proofing/mechanics', isAuth, ProofingController.checkMechanics);

// Overused words, across a whole story rather than the open chapter. The count
// is local and exact; the verdicts are Gemini's and are only asked for when the
// writer ticks the box, so this endpoint works with the AI switched off.
router.get('/proofing/overuse/words', isAuth, ProofingController.getOveruseWords);
router.post('/proofing/overuse', isAuth, ProofingController.checkOveruse);

// --- MANUSCRIPT BACKUP (GitHub) ---
// isModerator rather than isAuth: this writes to the writer's GitHub account
// and creates repositories, which is not something a reader account should
// reach. Repositories created here are always private - see GitHubService.
const GitController = require('../controllers/GitController.js');
router.get('/git/status', isModerator, GitController.getStatus);
router.get('/git/stories', isModerator, GitController.listStories);
router.post('/git/connect', isModerator, GitController.connect);
router.post('/git/disconnect', isModerator, GitController.disconnect);
router.get('/git/repos', isModerator, GitController.listRepos);
router.post('/git/repos', isModerator, GitController.createRepo);
router.post('/git/select', isModerator, GitController.selectRepo);
router.post('/git/untrack-audio', isModerator, GitController.untrackAudio);
router.post('/git/backup', isModerator, GitController.backup);

// --- DICTIONARY (spelling + pronunciation, one list) ---
// These replaced /proofing/dictionary and /proofing/pronunciation, which were
// two stores keyed differently: a word added to one was never seen by the
// other, so "add to dictionary" never stopped a word being reported unknown.
const DictionaryController = require('../controllers/DictionaryController.js');
router.get('/dictionary', isAuth, DictionaryController.get);
router.post('/dictionary', isAuth, DictionaryController.set);
router.post('/dictionary/remove', isAuth, DictionaryController.remove);
router.post('/dictionary/move', isAuth, DictionaryController.move);
router.get('/dictionary/phonemes', isAuth, DictionaryController.phonemes);

// --- NARRATOR (Piper, local) ---
// Rendering a chapter is the only long call here; it reports over Socket.io
// as it goes. Nothing in this section reaches the network except the voice
// catalogue and the one-time download of a voice.
const NarratorController = require('../controllers/NarratorController.js');
router.get('/narrator/voices', isAuth, NarratorController.getVoices);
router.post('/narrator/voices/install', isAuth, NarratorController.installVoice);
router.delete('/narrator/voices/:id', isAuth, NarratorController.removeVoice);
router.get('/narrator/voices/:id/speakers', isAuth, NarratorController.getSpeakers);
router.get('/narrator/phonemes', isAuth, NarratorController.getPhonemes);
router.get('/narrator/say', isAuth, NarratorController.say);
router.get('/narrator/audio/plan', isAuth, NarratorController.getPlan);
router.post('/narrator/audio/render', isAuth, NarratorController.render);
router.get('/narrator/audio/manifest', isAuth, NarratorController.getManifest);
router.get('/narrator/audio/segment/:file', isAuth, NarratorController.getSegment);

// The performed take, rendered to <story>/export/chapter_NN/. Gemini rather
// than Piper, and metered - see ExportService.
router.get('/narrator/export/plan', isAuth, NarratorController.getExportPlan);
router.post('/narrator/export/render', isAuth, NarratorController.renderExport);
// Whatever is rendered so far, stitched in memory - chapter.wav only exists
// once the chapter is complete, and this is for hearing it before then.
router.get('/narrator/export/preview', isAuth, NarratorController.getExportPreview);
router.post('/narrator/audio/clear', isAuth, NarratorController.clear);
router.get('/narrator/music', isAuth, NarratorController.getMusic);
router.get('/narrator/music/:file', isAuth, NarratorController.playMusic);

// --- STORY CRITIC ---
// Passage-based only. The old volume-wide route fed the critic a comic
// screenplay built by ScriptService; both are gone. The engine takes text.
router.get('/critic/options', isAuth, CriticController.getOptions);
router.post('/critic/text', isAuth, CriticController.analyzeText);

// --- USER ROUTES ---
router.post("/user/register", UserController.registerUser);
router.get('/user', isAuth, UserController.getUser);
router.post('/user/update', isAuth, UserController.updateUser);
router.post('/user/avatar', isAuth, uploadUserAvatar.single('avatar'), UserController.uploadAvatar);

// --- LIBRARY & VOLUME ROUTES ---
// "Library" here means the series/volume/chapter data the dashboard's own
// selectors read. The reader-facing library browser is gone.
router.get('/library/series', isAuth, LibraryController.getSeries);
router.get('/library/series/:seriesId', isAuth, LibraryController.getSeriesDetails);
router.put('/library/series/:seriesId/settings', isModerator, LibraryController.updateSeriesSettings);

router.post('/volume/create', isAdmin, VolumeController.createVolume);
router.get('/volumes', isModerator, VolumeController.getVolumes);
router.get('/volumes/:volumeId/chapters', isModerator, VolumeController.getChapters);
router.get('/volumes/:volumeId/chapters/:chapterId', isModerator, VolumeController.getChapterDetails);
router.put('/volumes/:volumeId/chapters/:chapterId', isModerator, VolumeController.updateChapter);

// --- VOLUME VIEW ROUTES ---
router.get('/volume/:id', isAuth, VolumeController.getVolumeById);
router.get('/volume/:id/chapter/:chapterNumber', isAuth, VolumeController.getChapterPages);

// Character avatars and user avatars are served straight off views/public by
// the static handler in server.js; they no longer need a controller.

// --- SCHEDULED TASKS & ADMIN ROUTES ---
// The library-roots and library-scan routes stood here. They served the comic
// engine's scanner: folders of comic files swept into series and volumes, with
// a Vision AI pass over the panel images. A manuscript is Markdown in a story
// folder, so none of it applied - and the vision half was already dead, its
// controller noting that the pipeline "went with the panel-image pipeline".

module.exports = router;
