const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const globalSettingsSchema = new Schema({
    key: {
        type: String,
        required: true,
        unique: true,
        default: "main"
    },
    // Where stories live on disk. The parent folder chosen in Settings; every
    // story is a folder inside it, every chapter a folder inside that, and
    // every page a .md file inside the chapter. Empty until the writer picks
    // one, which is why the editor asks for it before it will save anything.
    storage: {
        storyRoot: { type: String, default: "" }
    },
    // Gemini as the cloud critic. This was `vision` — panel-image description
    // for the comic server — and the name outlived the feature: the only thing
    // reading it is GeminiCriticService, which critiques prose. The vision-only
    // fields (panel systemPrompt, maxTokens, temperature, autoScanOnSave) are
    // gone; nothing read them. Migrated from `vision` on boot.
    critic: {
        enabled: { type: Boolean, default: false },
        apiKey: { type: String, default: "" }, // Encrypted
        modelName: { type: String, default: "gemini-flash-latest" }
    }
}, { timestamps: true });

module.exports = mongoose.model('GlobalSettings', globalSettingsSchema);
