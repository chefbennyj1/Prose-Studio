// Settings-side storage: read and set the story root, and browse the disk to
// find it. Browsing is the one thing in the app that looks outside the root,
// and it exists only so the writer can point at a folder by clicking.

const Storage = require('../services/StorageService');

// --- GET /api/storage/root ---
// Not admin-gated: the editor needs to know whether a root is set so it can
// say "choose a folder in Settings" instead of failing on the first save.
exports.getRoot = async (req, res) => {
    try {
        const root = await Storage.getStoryRoot();
        res.json({ ok: true, root, configured: Boolean(root) });
    } catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
};

// --- PUT /api/storage/root (admin) ---
exports.setRoot = async (req, res) => {
    try {
        const root = await Storage.setStoryRoot(req.body?.path);
        res.json({ ok: true, root, message: `Stories will be saved in ${root}` });
    } catch (err) {
        res.status(400).json({ ok: false, message: err.message });
    }
};

// --- GET /api/storage/browse?path= (admin) ---
exports.browse = async (req, res) => {
    try {
        res.json({ ok: true, ...(await Storage.browse(req.query.path)) });
    } catch (err) {
        res.status(400).json({ ok: false, message: err.message });
    }
};

// --- POST /api/storage/folder (admin) ---
exports.createFolder = async (req, res) => {
    const { parent, name } = req.body || {};
    try {
        res.json({ ok: true, ...(await Storage.createFolder(parent, name)) });
    } catch (err) {
        res.status(400).json({ ok: false, message: err.message });
    }
};
