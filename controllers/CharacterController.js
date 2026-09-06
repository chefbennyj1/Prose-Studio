const Character = require('../models/Character');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const CharacterService = require('../services/CharacterService');

/**
 * Move an uploaded image into the story folder it belongs to.
 *
 * resolveSeriesPath stood here, resolving a Series record to a comic library
 * directory. Characters are keyed to a story now - see models/Character.js -
 * so the destination is the story's own folder, which means a character's
 * reference art travels with the manuscript and is backed up alongside it.
 */
async function handleCharacterFileUpload(req, subDir) {
    if (!req.file) return { error: 'No file uploaded', status: 400 };

    const charId = req.params.id;
    const character = await Character.findById(charId);
    if (!character) return { error: 'Character not found', status: 404 };

    const destDir = await CharacterService.assetDir(character.story, charId, subDir);
    const fileName = path.basename(req.file.path);

    // Moved out of multer's temp location, not copied: two copies of a
    // reference image is one more than anybody wanted.
    await fsPromises.rename(req.file.path, path.join(destDir, fileName));

    return {
        charId,
        relativePath: `/api/images/story/${encodeURIComponent(character.story)}`
            + `/characters/${charId}/${subDir}/${fileName}`
    };
}

class CharacterController {
  // analyzeAvatar ran the avatar through Gemini vision to generate a physical
  // description. That was art-derived character bible data; prose character
  // sheets are written, not inferred from a picture.
  async getAll(req, res) {
    try {
      const characters = await CharacterService.getAllCharacters(req.query.story);
      res.json({ ok: true, characters });
    } catch (error) {
      res.status(500).json({ ok: false, message: error.message });
    }
  }

  async getOne(req, res) {
    try {
      const character = await CharacterService.getCharacterByName(req.params.name, req.query.story);
      if (!character) return res.status(404).json({ ok: false, message: 'Character not found' });
      res.json({ ok: true, character });
    } catch (error) {
      res.status(500).json({ ok: false, message: error.message });
    }
  }

  async create(req, res) {
    try {
      const character = await CharacterService.createCharacter(req.body);
      res.status(201).json({ ok: true, character });
    } catch (error) {
      res.status(400).json({ ok: false, message: error.message });
    }
  }

  async update(req, res) {
    try {
      const character = await CharacterService.updateCharacter(req.params.id, req.body);
      if (!character) return res.status(404).json({ ok: false, message: 'Character not found' });
      res.json({ ok: true, character });
    } catch (error) {
      res.status(400).json({ ok: false, message: error.message });
    }
  }

  async delete(req, res) {
    try {
      const result = await CharacterService.deleteCharacter(req.params.id);
      if (!result) return res.status(404).json({ ok: false, message: 'Character not found' });
      res.json({ ok: true, message: 'Character deleted successfully' });
    } catch (error) {
      res.status(500).json({ ok: false, message: error.message });
    }
  }

  async uploadAvatar(req, res) {
    try {
        const result = await handleCharacterFileUpload(req, 'avatar');
        if (result.error) return res.status(result.status).json({ ok: false, message: result.error });
        
        await CharacterService.updateCharacter(result.charId, { image: result.relativePath });
        res.json({ ok: true, image: result.relativePath });
    } catch (error) {
        console.error("[CharacterLab] Avatar upload error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
  }

  async uploadReferenceImage(req, res) {
    try {
        const result = await handleCharacterFileUpload(req, 'references');
        if (result.error) return res.status(result.status).json({ ok: false, message: result.error });

        const updatedChar = await CharacterService.addReferenceImage(result.charId, result.relativePath);
        res.json({ ok: true, url: result.relativePath, referenceImages: updatedChar.referenceImages });
    } catch (error) {
        console.error("[CharacterLab] Reference upload error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
  }

  /**
   * Serve a character's image out of the story folder.
   *
   * There was NO route behind the old /api/images/... paths at all - uploads
   * wrote a URL that had never resolved, so avatars and reference art were
   * broken independently of the Series problem.
   *
   * Every segment is validated rather than trusted: the id must look like a
   * Mongo id, the kind is one of two fixed words, and the filename may not
   * contain a separator. assetDir applies the same containment check the rest
   * of the app uses, so a crafted story name cannot escape the story root.
   */
  async getImage(req, res) {
    const { story, id, kind, file } = req.params;
    try {
      if (!/^[a-f0-9]{24}$/i.test(id)) throw new Error('Not a character id.');
      if (!['avatar', 'references'].includes(kind)) throw new Error('Not a character image.');
      if (!file || /[/]/.test(file) || file.includes('..')) throw new Error('Not a file name.');

      const dir = await CharacterService.assetDir(story, id, kind);
      res.sendFile(path.join(dir, file), (err) => {
        if (err && !res.headersSent) res.status(404).json({ ok: false, message: 'No such image.' });
      });
    } catch (error) {
      res.status(400).json({ ok: false, message: error.message });
    }
  }
}

module.exports = new CharacterController();

