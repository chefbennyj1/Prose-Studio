const Character = require('../models/Character');
const fs = require('fs').promises;
const path = require('path');

class CharacterService {
  async getAllCharacters(seriesId) {
    const filter = seriesId ? { series: seriesId } : {};
    return await Character.find(filter).sort({ name: 1 });
  }

  async getCharacterByName(name, seriesId) {
    const filter = { name };
    if (seriesId) filter.series = seriesId;
    return await Character.findOne(filter);
  }

  async createCharacter(data) {
    const character = new Character(data);
    const saved = await character.save();
    await this.syncCharactersToFS(saved.series);
    return saved;
  }

  async updateCharacter(id, data) {
    const updated = await Character.findByIdAndUpdate(id, data, { new: true });
    if (updated) await this.syncCharactersToFS(updated.series);
    return updated;
  }

  async addReferenceImage(id, imagePath) {
    const updated = await Character.findByIdAndUpdate(
      id,
      { $push: { referenceImages: imagePath } },
      { new: true }
    );
    if (updated) await this.syncCharactersToFS(updated.series);
    return updated;
  }

  async deleteCharacter(id) {
    const char = await Character.findById(id);
    if (!char) return null;
    const seriesId = char.series;
    const result = await Character.findByIdAndDelete(id);
    await this.syncCharactersToFS(seriesId);
    return result;
  }

  async syncCharactersToFS(seriesId) {
    try {
        const { resolveSeriesPath } = require('./HierarchyLookupService');
        const seriesPath = await resolveSeriesPath(seriesId);
        const characters = await this.getAllCharacters(seriesId);
        
        const jsonPath = path.join(seriesPath, 'characters.json');
        await fs.writeFile(jsonPath, JSON.stringify(characters, null, 2));
        console.log(`[CharacterService] Synced ${characters.length} characters to ${jsonPath}`);
    } catch (err) {
        console.error("[CharacterService] Sync to FS failed:", err.message);
    }
  }
}

module.exports = new CharacterService();

