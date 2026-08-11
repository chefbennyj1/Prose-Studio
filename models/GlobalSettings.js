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
    },
    // Manuscript backup to GitHub.
    //
    // One repository PER STORY, not one for the story root. The root is the
    // parent folder every story sits inside, so backing it up as a single
    // repository swept unrelated work in with the novel — a scratch story used
    // for testing went up alongside the real manuscript on the first run. A
    // novel is the unit a writer thinks in, so it is the unit that gets a repo.
    //
    // `private` is recorded rather than chosen: repositories this creates are
    // always private, and the field exists so the dashboard can show the
    // visibility of one the writer connected themselves.
    github: {
        token: { type: String, default: "" },   // Encrypted classic PAT, `repo` scope
        repos: [{
            _id: false,
            story: { type: String, required: true },   // folder name under the story root
            owner: { type: String, default: "" },
            repo: { type: String, default: "" },
            private: { type: Boolean, default: true }
        }]
    }
}, { timestamps: true });

module.exports = mongoose.model('GlobalSettings', globalSettingsSchema);
