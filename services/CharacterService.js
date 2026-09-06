const Character = require('../models/Character');
const fs = require('fs').promises;
const path = require('path');

const Storage = require('./StorageService');

/**
 * CharacterService
 *
 * Characters belong to a STORY - the folder on disk - rather than to a Series
 * record. See models/Character.js for why that changed and why it was safe to
 * change outright.
 *
 * The cast is mirrored to `characters.json` inside the story folder on every
 * write. That predates the re-key and is worth keeping: it puts the cast beside
 * the prose, so it is backed up to GitHub with the manuscript, readable without
 * the app, and survives the database being thrown away.
 */

/**
 * Where a story's character assets live.
 *
 * `characters/` rather than `.characters/`, and inside the story folder rather
 * than beside the app: reference images are things a writer wants to open, and
 * they belong to the book, so moving or deleting a story takes its cast with
 * it. listChapters only globs *.md files, so a folder here cannot be mistaken
 * for a chapter.
 */
async function storyPath(story) {
  const root = await Storage.requireStoryRoot();
  const clean = String(story || '').trim();
  if (!clean) throw new Error('Open a story first.');
  if (!Storage.isSafeSegment(clean)) throw new Error('Invalid story name.');

  const dir = path.join(root, clean);
  const relative = path.relative(root, dir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('That location is outside the story folder.');
  }
  return dir;
}

class CharacterService {
  async getAllCharacters(story) {
    const filter = story ? { story } : {};
    return await Character.find(filter).sort({ name: 1 });
  }

  async getCharacterByName(name, story) {
    const filter = { name };
    if (story) filter.story = story;
    return await Character.findOne(filter);
  }

  async createCharacter(data) {
    const character = new Character(data);
    const saved = await character.save();
    await this.syncCharactersToFS(saved.story);
    return saved;
  }

  async updateCharacter(id, data) {
    const updated = await Character.findByIdAndUpdate(id, data, { new: true });
    if (updated) await this.syncCharactersToFS(updated.story);
    return updated;
  }

  async addReferenceImage(id, imagePath) {
    const updated = await Character.findByIdAndUpdate(
      id,
      { $push: { referenceImages: imagePath } },
      { new: true }
    );
    if (updated) await this.syncCharactersToFS(updated.story);
    return updated;
  }

  async deleteCharacter(id) {
    const char = await Character.findById(id);
    if (!char) return null;
    const story = char.story;
    const result = await Character.findByIdAndDelete(id);
    await this.syncCharactersToFS(story);
    return result;
  }

  /** The folder a character's images belong in. */
  async assetDir(story, characterId, subDir = '') {
    const dir = path.join(await storyPath(story), 'characters', String(characterId), subDir);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Mirror the cast into the story folder.
   *
   * Failure is logged and swallowed, deliberately: the database is the record
   * and this is a convenience copy. A story folder that has been unplugged - a
   * real case here, the manuscript lives on removable storage - must not stop
   * a writer editing a character.
   */
  async syncCharactersToFS(story) {
    if (!story) return;
    try {
      const dir = await storyPath(story);
      const characters = await this.getAllCharacters(story);

      const jsonPath = path.join(dir, 'characters.json');
      await fs.writeFile(jsonPath, JSON.stringify(characters, null, 2));
      console.log(`[CharacterService] Synced ${characters.length} character(s) to ${jsonPath}`);
    } catch (err) {
      console.error('[CharacterService] Sync to FS failed:', err.message);
    }
  }
}

module.exports = new CharacterService();
