const db = require('../services/db');
const Schema = db.Schema;

const seriesSchema = new Schema({
    title: {
        type: String,
        required: true
    },
    folderName: {
        type: String,
        required: true,
        unique: true
    },
    libraryRoot: {
        type: Schema.Types.ObjectId,
        ref: 'LibraryRoot',
        default: null
    },
    sourcePath: {
        type: String, // Optional absolute path override
        default: ""
    },
    description: {
        type: String,
        default: ""
    },
    coverImage: {
        type: String, // Path to cover image
        default: ""
    },
    volumes: [{
        type: Schema.Types.ObjectId,
        ref: 'Volume'
    }],
    settings: {
        actionTextFontSize: { type: String, default: "2.5rem" },
        primaryFontFamily: { type: String, default: "" },
        actionFontFamily: { type: String, default: "Ka Blam" },
        
        // TextBlock Colors
        narratorBg: { type: String, default: "#000000" },
        narratorColor: { type: String, default: "#ffffff" },
        narratorBorder: { type: String, default: "#ffffff" },
        
        monologueBg: { type: String, default: "#ffffff" },
        monologueColor: { type: String, default: "#000000" },
        monologueBorder: { type: String, default: "#000000" },
        monologueDot: { type: String, default: "#ffff00" },

        customCssFiles: [{ type: String }]
    }
}, { timestamps: true });

module.exports = db.model('Series', seriesSchema);
