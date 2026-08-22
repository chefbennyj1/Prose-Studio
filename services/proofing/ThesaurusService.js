// services/proofing/ThesaurusService.js

/**
 * ThesaurusService
 *
 * Datamuse. No key, no account, no quota worth the name, and no model - which
 * makes it the same class of tool as the spellchecker and the mechanics scan:
 * it works with the AI switched off, and it cannot invent a word that does not
 * exist.
 *
 * WHY THIS IS NOT JUST A LIST OF SYNONYMS.
 *
 * Ben's own warning, and it is the design constraint here: the worst thing a
 * writer can do is open a thesaurus and start picking impressive words. A
 * panel that returns forty synonyms IS that machine. So:
 *
 *   - Results carry FREQUENCY, and rare words are pushed to the bottom rather
 *     than mixed in with common ones. "Perambulate" and "walk" are synonyms;
 *     they are not interchangeable in a novel.
 *   - Results carry PART OF SPEECH, so a noun is not offered as a swap for a
 *     verb - the commonest way a thesaurus produces a sentence that no longer
 *     parses.
 *   - The list is short. A long list is a shopping trip; a short one is a
 *     decision.
 *
 * Two queries, merged. `rel_syn` is true synonymy out of WordNet and is
 * precise but thin; `ml` ("means like") is built from real usage and is what
 * finds the word you actually wanted. Synonyms first, `ml` to fill.
 */

const ENDPOINT = 'https://api.datamuse.com/words';

/** Enough to choose from, few enough to read. See the note above. */
const MAX_RESULTS = 12;

/** Asked for per result: f = frequency per million words, p = part of speech. */
const METADATA = 'fp';

/**
 * Frequency below which a word is "rare" and gets sorted to the bottom.
 *
 * Per million words. 1.0 is roughly the boundary between a word a reader
 * passes over and one they stop on - "gleam" is about 2, "coruscate" is far
 * below 0.1. Words at the bottom are still SHOWN, because sometimes the odd
 * one is exactly right; they are just not offered first.
 */
const RARE_BELOW = 1.0;

/** Per million words. Above this a word is grammar, not vocabulary. */
const FUNCTION_WORD_ABOVE = 500;

/**
 * Cached because a writer looks up the same word repeatedly while working a
 * paragraph, and because Datamuse is someone else's server being used for
 * free. Small and unbounded-ish: entries are a dozen short strings.
 */
const cache = new Map();
const CACHE_LIMIT = 500;

class ThesaurusService {

    /**
     * @param {string} word
     * @param {object} opts  { pos: 'n'|'v'|'adj'|'adv' } to match the word's own role
     * @returns {Promise<{word, results: Array, source: string}>}
     */
    async lookup(word, opts = {}) {
        const term = String(word || '').trim().toLowerCase();
        if (!term) return { word: '', results: [], source: 'datamuse' };
        if (!/^[\p{L}'’-]+$/u.test(term)) {
            // One word. A phrase is a different question and Datamuse answers
            // it badly - better to say so than to return nonsense.
            throw new Error('Look up a single word.');
        }

        const key = `${term}|${opts.pos || ''}`;
        if (cache.has(key)) return cache.get(key);

        /*
         * Three queries, because no single one of them is good enough.
         *
         *   rel_syn(term)  precise, but LEMMA-BASED - "walked" and "stuttered"
         *                  return nothing, and "said" returns the adjective
         *                  sense (aforementioned) rather than the verb.
         *   rel_syn(stem)  the real synonyms for an inflected word: "say" ->
         *                  articulate, state, tell, allege. Base forms though.
         *   ml(term)       correctly inflected, and noisy - it offered "base
         *                  on balls" for "walked", which is the baseball sense.
         *
         * So the stem's synonyms are used as a QUALITY FILTER over `ml`: a
         * word that appears in both is a genuine synonym AND already in the
         * right tense. That intersection is the best answer this can give.
         */
        const stem = stemOf(term);
        const [synonyms, meansLike, stemSynonyms] = await Promise.all([
            this.#query({ rel_syn: term }),
            this.#query({ ml: term }),
            stem !== term ? this.#query({ rel_syn: stem }) : Promise.resolve([])
        ]);

        const stemSet = new Set(stemSynonyms.map(e => stemOf(e.word)));

        /*
         * Ranked in tiers of confidence, best first, because the list is short
         * and what fills it decides whether this is useful or a distraction.
         */
        const verified = meansLike.filter(e => stemSet.has(stemOf(e.word)));

        const seen = new Set([term]);
        const merged = [];
        const add = (entries, tier) => {
            for (const entry of entries) {
                const w = entry.word.toLowerCase();
                if (seen.has(w)) continue;

                // Multi-word results are never a swap for one highlighted
                // word. "manner of walking" and "walk of life" answer a
                // different question.
                if (/[\s-]/.test(w)) continue;

                /*
                 * Function words, dropped by how common they are rather than
                 * by a list. Datamuse answers "said" with "was", "were" and
                 * "had" - all technically related, none of them a word anyone
                 * chooses. Nothing above this rate is a considered choice; the
                 * threshold sits well clear of ordinary vocabulary, which
                 * lives one to two orders of magnitude below it.
                 */
                if (entry.frequency > FUNCTION_WORD_ABOVE) continue;

                seen.add(w);
                // `baseForm` warns the UI that this one may need its tense
                // fixing - it is a synonym of the stem, not of the word.
                merged.push({ ...entry, baseForm: tier === 'stem' });
            }
        };

        add(synonyms, 'exact');       // right word, right form
        add(verified, 'verified');    // right form, confirmed synonym
        add(stemSynonyms, 'stem');    // real synonym, base form
        add(meansLike, 'loose');      // last resort

        collapseInflections(merged, term);

        const wanted = opts.pos ? merged.filter(e => !e.parts.length || e.parts.includes(opts.pos)) : merged;
        const usable = wanted.length ? wanted : merged;

        /*
         * Common words first, rare ones last, and within each band the order
         * Datamuse gave - which is its own relevance ranking and is better
         * than anything re-sorting by frequency alone would produce.
         */
        const common = usable.filter(e => e.frequency >= RARE_BELOW);
        const rare = usable.filter(e => e.frequency < RARE_BELOW);

        const results = [...common, ...rare].slice(0, MAX_RESULTS);
        const answer = { word: term, results, source: 'datamuse' };

        if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
        cache.set(key, answer);
        return answer;
    }

    async #query(params) {
        const query = new URLSearchParams({ ...params, md: METADATA, max: '30' });

        let response;
        try {
            response = await fetch(`${ENDPOINT}?${query}`);
        } catch (err) {
            // Offline, or Datamuse is down. Not the writer's fault and not
            // something they can fix, so say which it is.
            throw new Error('Could not reach the thesaurus. Check the connection and try again.');
        }
        if (!response.ok) throw new Error(`The thesaurus returned ${response.status}.`);

        const raw = await response.json();
        return raw.map(entry => ({
            word: entry.word,
            // tags look like ["n", "f:12.345"] - part of speech, then frequency.
            parts: (entry.tags || []).filter(t => !t.startsWith('f:')),
            frequency: frequencyOf(entry.tags),
            rare: frequencyOf(entry.tags) < RARE_BELOW
        }));
    }
}

/**
 * Keep ONE form of each word, and prefer the one that matches how the writer's
 * word is inflected.
 *
 * Datamuse returns "stammer", "stammered", "stammering" and "stammeringly" as
 * four separate answers for "stuttered". They are one suggestion, and offering
 * four wastes the short list the whole design depends on.
 *
 * The form kept is the one whose ending matches the query's, so a word chosen
 * for "stuttered" arrives as "stammered" and drops into the sentence without
 * the writer having to fix the tense afterwards. That is the difference
 * between a suggestion and a chore.
 *
 * Only endings that are genuinely inflections are collapsed - "light" and
 * "lighten" are different words and both survive.
 */
const INFLECTIONS = ['ing', 'ed', 'es', 'en', 's', 'd'];

function endingOf(word) {
    return INFLECTIONS.find(suffix => word.endsWith(suffix)) || '';
}

/**
 * Naive on purpose, but not reckless.
 *
 * A stem shorter than four letters is not a stem, it is damage: "said" ends in
 * "d" and would become "sai", "pass" ends in "s" and would become "pas". Both
 * then fail every lookup and quietly poison the ranking. Irregular verbs
 * (said -> say, saw -> see) are simply out of reach here and fall back to the
 * `ml` query, which handles them by usage rather than by morphology.
 */
const MIN_STEM = 4;

function stemOf(word) {
    const ending = endingOf(word);
    if (!ending) return word;
    const stem = word.slice(0, -ending.length);
    return stem.length >= MIN_STEM ? stem : word;
}

function collapseInflections(entries, term) {
    const wanted = endingOf(term);
    const groups = new Map();

    for (const entry of entries) {
        const stem = stemOf(entry.word);
        // Too short to be a safe stem: "as"/"ash" would collapse together.
        const key = stem.length >= 4 ? stem : entry.word;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(entry);
    }

    const keep = new Set();
    for (const group of groups.values()) {
        // The form inflected like the writer's word, or failing that the one
        // Datamuse ranked highest - which is already first in the group.
        const match = group.find(e => endingOf(e.word) === wanted);
        keep.add(match || group[0]);
    }

    for (let i = entries.length - 1; i >= 0; i--) {
        if (!keep.has(entries[i])) entries.splice(i, 1);
    }
}

/** "f:12.345" -> 12.345. Absent means unknown, which is treated as rare. */
function frequencyOf(tags) {
    const found = (tags || []).find(t => t.startsWith('f:'));
    return found ? Number(found.slice(2)) || 0 : 0;
}

module.exports = new ThesaurusService();
module.exports.RARE_BELOW = RARE_BELOW;
