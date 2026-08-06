const fs = require('fs');
const path = require('path');
const nspell = require('nspell');
const Character = require('../../models/Character');
const DictionaryService = require('./DictionaryService');

/**
 * SpellService
 *
 * Deterministic spelling for prose. This exists because the local 4B is bad at
 * mechanical checking — see the guards the Proof-Reader plugin had to grow
 * around its grammar pass. A dictionary answers "is this string a word" exactly
 * and identically every time; a small model estimates, and estimates badly in
 * both directions. Spelling belongs here, and Gemma is left to the judgment
 * calls no rule can encode.
 *
 * `dictionary-en` is ESM-only, but it ships plain Hunspell `.aff`/`.dic` data
 * files. Reading those with fs and handing the buffers to nspell (which is
 * CommonJS) keeps this file in the codebase's module system with no dynamic
 * import and no build step.
 *
 * Two things the browser's built-in spellcheck cannot do, and the reason this
 * is worth having at all:
 *   1. The results are readable — the browser gives squiggles no API can query,
 *      so a manuscript-wide report is impossible with it.
 *   2. The dictionary can be seeded. Character names come from the Character
 *      model automatically; the browser's "add to dictionary" is per-machine,
 *      user-typed and unseedable.
 */

/**
 * `dictionary-en` declares `"exports": "./index.js"`, so subpaths such as
 * `dictionary-en/package.json` are not resolvable. Resolving the package entry
 * is allowed — `require.resolve` only does path resolution and never loads the
 * module, so the ESM-ness never comes into play — and its directory is where
 * the .aff/.dic data files sit.
 */
function resolveDictDir() {
    try {
        return path.dirname(require.resolve('dictionary-en'));
    } catch (err) {
        const fallback = path.join(__dirname, '..', '..', 'node_modules', 'dictionary-en');
        if (fs.existsSync(path.join(fallback, 'index.dic'))) return fallback;
        throw new Error(`Could not locate the dictionary-en package: ${err.message}`);
    }
}


// Straight/curly apostrophes and hyphens may sit inside a word; anything else
// ends it. \p{L} keeps accented names (Zoë, Renée) in one piece.
const WORD_RE = /\p{L}[\p{L}'’‘-]*/gu;

class SpellService {
    constructor() {
        this.base = null;
        this.seriesCache = new Map(); // seriesFolder -> { checker, loadedAt }
    }

    /**
     * Parse the Hunspell dictionary once. ~540KB of .dic; the parse is the
     * expensive part, so every series checker is cloned from this.
     */
    loadBase() {
        if (this.base) return this.base;
        const dictDir = resolveDictDir();
        const aff = fs.readFileSync(path.join(dictDir, 'index.aff'));
        const dic = fs.readFileSync(path.join(dictDir, 'index.dic'));
        console.log('[SpellService] Loading base English dictionary...');
        this.base = { aff, dic };
        return this.base;
    }

    /**
     * The accepted words now come from DictionaryService, which holds the
     * global layer and the story layer together with their pronunciations.
     * This service owns "is it a word"; it no longer owns the list.
     */
    async readCustomWords(story) {
        return DictionaryService.words(story);
    }

    async addCustomWord(story, word) {
        const layers = await DictionaryService.set('story', story, word);
        this.seriesCache.delete(story);
        return Object.keys({ ...layers.global, ...layers.story });
    }

    /**
     * Character names are the single biggest source of false positives in
     * fiction, and they are already in the database. Split multi-word names so
     * "Vera Locke" contributes both halves.
     */
    async characterWords() {
        try {
            const characters = await Character.find({}, 'name').lean();
            const words = new Set();
            for (const c of characters) {
                for (const part of String(c.name || '').split(/[\s'’-]+/)) {
                    if (part.length > 1) words.add(part);
                }
            }
            return [...words];
        } catch (err) {
            console.error('[SpellService] Could not read character names:', err.message);
            return [];
        }
    }

    async getChecker(seriesFolder = '') {
        const cached = this.seriesCache.get(seriesFolder);
        if (cached) return cached;

        const { aff, dic } = this.loadBase();
        const checker = nspell(aff, dic);

        const extra = [...(await this.characterWords()), ...(await this.readCustomWords(seriesFolder))];
        for (const word of extra) checker.add(word);

        console.log(`[SpellService] Checker ready for "${seriesFolder || 'default'}" (+${extra.length} project words).`);
        this.seriesCache.set(seriesFolder, checker);
        return checker;
    }

    /** Drop the cached checker so newly added names are picked up. */
    invalidate(seriesFolder) {
        if (seriesFolder === undefined) this.seriesCache.clear();
        else this.seriesCache.delete(seriesFolder);
    }

    /**
     * A token counts as correct if the dictionary accepts it, or accepts it
     * once a possessive is removed, or (for a hyphenated compound) accepts
     * every part. Proper nouns added at runtime carry no affix rules, so
     * "Locke's" has to be resolved by stripping rather than by the dictionary.
     */
    isCorrect(checker, token) {
        if (checker.correct(token)) return true;

        const normalized = token.replace(/[’‘]/g, "'");
        if (normalized !== token && checker.correct(normalized)) return true;

        const bare = normalized.replace(/'s$/i, '').replace(/s'$/i, 's');
        if (bare !== normalized && checker.correct(bare)) return true;

        // ALL CAPS is usually an acronym or emphasis; accept if the word is
        // known in lower case rather than flagging every shout in the dialogue.
        if (/^\p{Lu}+$/u.test(normalized) && checker.correct(normalized.toLowerCase())) return true;

        if (normalized.includes('-')) {
            const parts = normalized.split('-').filter(Boolean);
            if (parts.length > 1 && parts.every(p => this.isCorrect(checker, p))) return true;
        }
        return false;
    }

    /**
     * @param {string} text
     * @param {object} opts { seriesFolder, maxSuggestions }
     * @returns {Promise<{ findings: Array, wordCount: number, unknownCount: number }>}
     *
     * Findings are grouped by word, not by occurrence: a character name the
     * dictionary does not know appears once with a count, not four hundred
     * times. That is the difference between a usable report and a wall.
     */
    async check(text, opts = {}) {
        const body = String(text || '');
        const checker = await this.getChecker(opts.seriesFolder || '');
        const maxSuggestions = opts.maxSuggestions ?? 4;

        // Offset -> line number, computed once rather than per match.
        const lineStarts = [0];
        for (let i = 0; i < body.length; i++) {
            if (body[i] === '\n') lineStarts.push(i + 1);
        }
        const lineOf = (offset) => {
            let lo = 0, hi = lineStarts.length - 1;
            while (lo < hi) {
                const mid = Math.ceil((lo + hi) / 2);
                if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
            }
            return lo + 1;
        };

        const grouped = new Map();
        let wordCount = 0;
        let unknownCount = 0;

        WORD_RE.lastIndex = 0;
        let match;
        while ((match = WORD_RE.exec(body)) !== null) {
            const token = match[0].replace(/['’‘-]+$/u, '');
            if (token.length < 2) continue;
            wordCount++;

            if (this.isCorrect(checker, token)) continue;
            unknownCount++;

            const key = token.toLowerCase();
            if (grouped.has(key)) {
                const entry = grouped.get(key);
                entry.count++;
                if (entry.occurrences.length < 10) {
                    entry.occurrences.push({ offset: match.index, line: lineOf(match.index) });
                }
                continue;
            }

            grouped.set(key, {
                word: token,
                count: 1,
                suggestions: checker.suggest(token).slice(0, maxSuggestions),
                occurrences: [{ offset: match.index, line: lineOf(match.index) }]
            });
        }

        const findings = [...grouped.values()].sort((a, b) =>
            b.count - a.count || a.word.localeCompare(b.word)
        );

        return { findings, wordCount, unknownCount };
    }
}

module.exports = new SpellService();
