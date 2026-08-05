const Character = require('../models/Character');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const CharacterService = require('../services/CharacterService');
const { resolveSeriesPath } = require('../services/HierarchyLookupService');

async function handleCharacterFileUpload(req, subDir) {
    if (!req.file) return { error: 'No file uploaded', status: 400 };

    const charId = req.params.id;
    const character = await Character.findById(charId);
    if (!character) return { error: 'Character not found', status: 404 };

    const seriesPath = await resolveSeriesPath(character.series);
    const destDir = path.join(seriesPath, 'Characters', charId, subDir);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    const fileName = path.basename(req.file.path);
    const destPath = path.join(destDir, fileName);

    // Move the file from temp storage to series folder
    await fsPromises.rename(req.file.path, destPath);

    return {
        charId,
        relativePath: `/api/images/${character.series}/characters/${charId}/${subDir}/${fileName}`
    };
}

class CharacterController {
  // analyzeAvatar ran the avatar through Gemini vision to generate a physical
  // description. That was art-derived character bible data; prose character
  // sheets are written, not inferred from a picture.
  async getAll(req, res) {
    try {
      const characters = await CharacterService.getAllCharacters(req.query.series);
      res.json({ ok: true, characters });
    } catch (error) {
      res.status(500).json({ ok: false, message: error.message });
    }
  }

  async getOne(req, res) {
    try {
      const character = await CharacterService.getCharacterByName(req.params.name, req.query.series);
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
}

module.exports = new CharacterController();

