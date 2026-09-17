const GlobalSettings = require('../models/GlobalSettings');
const { encrypt, decrypt } = require('../utils/encryption');

exports.getGlobalSettings = async (req, res) => {
    try {
        let settings = await GlobalSettings.findOne({ key: "main" });
        if (!settings) {
            settings = new GlobalSettings({ key: "main" });
            await settings.save();
        }

        // Mask the API key for the response
        const settingsObj = settings.toObject();
        if (settingsObj.critic && settingsObj.critic.apiKey) {
            const decrypted = decrypt(settingsObj.critic.apiKey);
            if (decrypted) {
                settingsObj.critic.apiKey = decrypted.substring(0, 4) + "****" + decrypted.substring(decrypted.length - 4);
            }
        }

        res.json({ ok: true, settings: settingsObj });
    } catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
};

exports.updateGlobalSettings = async (req, res) => {
    const { settings } = req.body;
    try {
        let doc = await GlobalSettings.findOne({ key: "main" });
        if (!doc) doc = new GlobalSettings({ key: "main" });

        if (settings.storage) {
            if (settings.storage.storyRoot !== undefined && settings.storage.storyRoot !== doc.storage.storyRoot) {
                doc.storage.storyRoot = settings.storage.storyRoot;

                // StorageService caches the root — it is read on nearly every
                // manuscript call — and only setStoryRoot() busted that cache.
                // This route writes the same field by another door, so without
                // this the engine kept using the OLD root until a restart:
                // chapters listed from the previous folder, and saves refused
                // with "no story folder is set" while Settings showed one.
                require('../services/StorageService.js').clearCache();
            }
        }

        if (settings.critic) {
            if (settings.critic.enabled !== undefined) doc.critic.enabled = settings.critic.enabled;
            if (settings.critic.modelName !== undefined) doc.critic.modelName = settings.critic.modelName;
            
            // Only update the API key if a new, unmasked one is provided
            if (settings.critic.apiKey && !settings.critic.apiKey.includes('****')) {
                doc.critic.apiKey = encrypt(settings.critic.apiKey);
            }
        }

        await doc.save();
        res.json({ ok: true, settings: doc });
    } catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
};
