const mongoose = require('mongoose');

const characterSchema = new mongoose.Schema({
  /*
   * THE STORY FOLDER'S NAME, not a Series id.
   *
   * This was `series: ObjectId ref 'Series'`, and it is why the Character Lab
   * had been dead since the comic conversion: a Series record is only ever
   * created by the comic library scanner, so in a prose app there are none.
   * The lab's dropdown had nothing to populate and its "+ New" button stayed
   * disabled forever, with no error to explain it.
   *
   * A story is a folder on disk, exactly like a chapter is a file in one, so
   * the key is the folder name - the same string every other feature here uses
   * (ManuscriptService, DictionaryService, ExportService, the word cloud).
   * Characters now live in the same world as the prose they belong to.
   *
   * Safe to change outright rather than migrate: series, libraryroots and
   * characters were all zero rows at the time of the switch.
   */
  story: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: ''
  },
  dialogueStylePrompt: {
    type: String, // Instructions for character's dialogue style (used natively or for LLM)
    default: ''
  },
  image: {
    type: String, // Path to avatar image
    default: ''
  },
  referenceImages: {
    type: [String], // Array of paths to reference images
    default: []
  },
  // Default visual styles for SpeechBubbles
  defaultStyle: {
    type: Object, // e.g., { "color": "#00ccff", "fontFamily": "Orbitron" }
    default: {}
  },
  // Default HTML attributes for SpeechBubbles
  defaultAttributes: {
    type: Object, // e.g., { "class": "cyber-bubble nova-style" }
    default: {}
  }
}, { timestamps: true });

module.exports = mongoose.model('Character', characterSchema);
