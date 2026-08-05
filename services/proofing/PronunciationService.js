const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/**
 * PronunciationService
 *
 * How a word should be SAID, when how it is spelled misleads the narrator.
 *
 * Text-to-speech guesses pronunciation from spelling, and fiction is full of
 * the exact words that defeats: invented names, borrowed ones, anything the
 * writer made up. "Silas" comes out "See-lass". Worse, it comes out that way
 * every single time, for the whole book.
 *
 * Entries are RESPELLINGS, not phonemes: "SY-liss", not /ˈsaɪləs/. That is a
 * deliberate trade. A respelling can be guessed at, typed by ear and tuned in
 * seconds; IPA cannot, and would send the writer to look up symbols instead of
 * writing. It also keeps this engine-agnostic - the substitution happens in
 * plain text before anything model-specific sees it, so it survives swapping
 * the voice out entirely.
 *
 * This NEVER touches the manuscript. It changes what is spoken, not what is
 * written; the file still says Silas.
 *
 * Stored beside the spelling dictionaries on purpose. The words a spell
 * checker does not recognise are very nearly the same list as the words a
 * narrator mispronounces, and both are per-story.
 */

const CUSTOM_DIR = path.join(__dirname, '..', '..', 'dictionaries');

/** Same shape of guard the spelling dictionary uses: a key, never a path. */
function fileFor(seriesFolder) {
    const safe = String(seriesFolder || 'default').replace(/[^a-z0-9_-]/gi, '_');
    return path.join(CUSTOM_DIR, `${safe}.pronunciation.json`);
}

class PronunciationService {

    /** @returns {Promise<Object<string,string>>} word -> respelling */
    async get(seriesFolder) {
        try {
            const raw = await fsp.readFile(fileFor(seriesFolder), 'utf8');
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (err) {
            // Absent is the normal case, and an unreadable one must not stop
            // the narrator: a missing pronunciation is a worse reading, not a
            // broken feature.
            if (err.code !== 'ENOENT') {
                console.error('[PronunciationService] Could not read lexicon:', err.message);
            }
            return {};
        }
    }

    /**
     * Adds or replaces one entry. An empty respelling removes it, so the same
     * call undoes a bad guess.
     */
    async set(seriesFolder, word, spoken) {
        const key = String(word || '').trim();
        if (!key) throw new Error('Give the word you want to fix.');
        if (/\s/.test(key)) throw new Error('One word at a time.');

        const lexicon = await this.get(seriesFolder);
        const value = String(spoken || '').trim();

        if (value) {
            lexicon[key] = value;
        } else {
            delete lexicon[key];
        }

        await fsp.mkdir(CUSTOM_DIR, { recursive: true });
        await fsp.writeFile(fileFor(seriesFolder), JSON.stringify(lexicon, null, 2), 'utf8');
        return lexicon;
    }
}

module.exports = new PronunciationService();
