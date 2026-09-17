const db = require('../services/db');
const Schema = db.Schema;


const pageSchema = new Schema({
    index: Number,
    path: String, // e.g. "views/Volumes/volume-1/chapter-1/page0/page0.html"
    layout: {
        id: { type: String, default: "Standard_Page" },
        html: { type: String, default: "Standard_Page.html" },
        css: { type: String, default: "" }
    },
    header: { type: Object, default: {} },   // Cache of page.json header
    mediaData: { type: Object, default: {} }, // Cache of consolidated media config
    sceneData: { type: Array, default: [] }   // Cache of consolidated scene cues
});

const chapterSchema = new Schema({
    title: String,
    chapterNumber: Number,
    pages: [pageSchema]
});

const volumeSchema = new Schema({
  series: {
    type: Schema.Types.ObjectId,
    ref: 'Series'
  },
    index: Number,
    title: String,
    volumePath: String, // e.g. "/views/Volumes/volume-1/"

    critique: String,
    lastCritiquedAt: Date,

    chapters: [chapterSchema]
});

module.exports = db.model('Volume', volumeSchema, 'Volumes');