// services/proofing/AdverbLexicon.js

/**
 * The vocabulary behind the weak-adverb scan.
 *
 * THE COUNT ON ITS OWN IS NOT THE FEATURE.
 *
 * Every tool on the market reports "you used 412 -ly adverbs", and that number
 * is close to meaningless. It is not a defect rate; it is roughly a function of
 * how long the book is. Worse, it teaches the wrong lesson: a writer shown a
 * big number deletes -ly words, and deleting "slowly" from "walked slowly"
 * leaves "walked", which is weaker than either "trudged" or the original. The
 * adverb was never the problem. It was the symptom.
 *
 * So this file is mostly about TELLING FOUR DIFFERENT THINGS APART, because
 * they are four different edits:
 *
 *   redundant  "whispered quietly" - the verb already contains the adverb, so
 *              the adverb is a straight cut and the sentence improves.
 *   tag        "said softly" - the Elmore Leonard one. The adverb is carrying
 *              emotion the dialogue should be carrying, and the fix is in the
 *              line of speech, not in the tag.
 *   propping   "walked slowly" - a generic verb held up by a modifier. The fix
 *              is a better verb, and deleting the adverb makes it worse.
 *   loose      Every other -ly adverb. Reported as a RATE rather than as a list
 *              of sins, because most of these are simply words.
 *
 * Unlike OveruseLexicon the word list here is not fixed and cannot be. Adverbs
 * are an open class - a novelist will coin one - so detection is morphological:
 * anything ending in -ly that is not in NOT_ADVERB. The fixed lists in this
 * file are the VERBS, because the verb is what makes a hit mean something.
 *
 * Nothing here calls a model, for the reason OveruseLexicon gives at length: a
 * count that is wrong is worse than no count, because the writer cannot tell.
 */

/**
 * The four kinds, strongest signal first. The panel offers these as toggles for
 * the same reason the overuse scan offers its groups: a writer doing a
 * deliberate adverb pass wants all four, and a writer drafting wants the top
 * two or nothing.
 */
const KINDS = {
    redundant: 'Redundant',
    tag: 'On dialogue tags',
    propping: 'Propping a weak verb',
    loose: 'Other -ly adverbs'
};

/** What the panel says about each kind. The edit, not the rule. */
const KIND_NOTES = {
    redundant: 'The verb already says this. The adverb is a clean cut.',
    tag: 'The adverb is carrying what the line of dialogue should carry.',
    propping: 'A general verb held up by a modifier. Look for the exact verb instead.',
    loose: 'Ordinary adverbs. Watch the rate, not the individual word.'
};

/**
 * Words ending in -ly that are not adverbs.
 *
 * This list is the entire accuracy of the scan. -ly is a suffix on ADJECTIVES
 * too ("friendly", "deadly", "elderly"), on nouns ("family", "supply",
 * "anomaly") and on verbs ("reply", "imply", "multiply"). Counting those is how
 * a scanner tells a writer their prose is full of adverbs it never found - and
 * a number the writer can disprove by looking is a number they stop trusting,
 * along with every other number in the panel.
 *
 * Adjectives are the dangerous class: common in fiction, and they look exactly
 * right to a naive matcher.
 */
const NOT_ADVERB = new Set([
    // Verbs.
    'apply', 'comply', 'imply', 'multiply', 'reply', 'rely', 'supply', 'ply',
    'fly', 'sully', 'dally', 'tally', 'rally', 'sally',

    // Nouns.
    'family', 'anomaly', 'assembly', 'monopoly', 'panoply', 'homily', 'doily',
    'belly', 'jelly', 'telly', 'folly', 'dolly', 'holly', 'lily', 'lolly',
    'brolly', 'gully', 'bully', 'ally', 'melancholy', 'butterfly', 'dragonfly',
    'firefly', 'gadfly', 'mayfly', 'horsefly', 'pulley',

    // Adjectives. The big false-positive class.
    'only', 'ugly', 'holy', 'silly', 'jolly', 'likely', 'unlikely', 'friendly',
    'unfriendly', 'lonely', 'lovely', 'deadly', 'costly', 'orderly',
    'disorderly', 'elderly', 'cowardly', 'worldly', 'timely', 'untimely',
    'homely', 'ghastly', 'burly', 'curly', 'surly', 'gnarly', 'wobbly',
    'knobbly', 'crumbly', 'wrinkly', 'prickly', 'sickly', 'stately', 'kingly',
    'princely', 'saintly', 'scholarly', 'brotherly', 'sisterly', 'motherly',
    'fatherly', 'neighborly', 'neighbourly', 'heavenly', 'godly', 'ungodly',
    'manly', 'womanly', 'portly', 'sprightly', 'unruly', 'bristly', 'grisly',
    'grizzly', 'measly', 'miserly', 'chilly', 'frilly', 'hilly', 'oily',
    'wily', 'sly', 'steely', 'smelly', 'shapely', 'seemly', 'unseemly',
    'lively', 'lowly',

    /*
     * Words that ARE adverbs and are deliberately not counted.
     *
     * These place a sentence in time rather than modifying a verb's manner,
     * which is the thing this scan is about. "Monthly" is not weak writing and
     * "early" is usually the only word for what it means.
     */
    'daily', 'nightly', 'weekly', 'monthly', 'yearly', 'quarterly', 'hourly',
    'early'
]);

/**
 * Speech verbs, for the dialogue-tag test.
 *
 * Deliberately generous about the shouty ones ("bellowed", "hissed") because
 * those are the tags that attract an adverb hardest - a writer who has already
 * reached past "said" is in the mood to reach again.
 */
const SPEECH_VERBS = new Set([
    'said', 'says', 'say', 'asked', 'asks', 'ask', 'replied', 'replies',
    'answered', 'answers', 'added', 'adds', 'told', 'tells', 'spoke', 'speaks',
    'whispered', 'whispers', 'muttered', 'mutters', 'murmured', 'murmurs',
    'mumbled', 'mumbles', 'shouted', 'shouts', 'yelled', 'yells', 'screamed',
    'screams', 'called', 'calls', 'cried', 'cries', 'snapped', 'snaps',
    'growled', 'growls', 'hissed', 'hisses', 'breathed', 'breathes', 'sighed',
    'sighs', 'laughed', 'laughs', 'barked', 'barks', 'bellowed', 'bellows',
    'demanded', 'demands', 'offered', 'offers', 'insisted', 'insists',
    'admitted', 'admits', 'observed', 'observes', 'remarked', 'remarks',
    'repeated', 'repeats', 'continued', 'continues', 'agreed', 'agrees',
    'countered', 'counters', 'protested', 'protests'
]);

/**
 * Generic verbs that an adverb tends to prop up.
 *
 * The test for membership was: is there almost always an exact verb that
 * replaces this one plus its adverb? "Walked slowly" is "trudged", "ambled",
 * "shuffled"; "looked quickly" is "glanced". Verbs with no such replacement are
 * not here, because the note would be advice the writer cannot take.
 *
 * "Said" is NOT in this list even though it is the most generic verb in
 * fiction. Replacing "said" is bad advice - it is invisible on the page and
 * that is its job. An adverb on "said" is caught as a dialogue tag instead,
 * where the note points at the dialogue rather than at the verb.
 */
const WEAK_VERBS = new Set([
    'walked', 'walks', 'walk', 'walking',
    'ran', 'runs', 'run', 'running',
    'moved', 'moves', 'move', 'moving',
    'went', 'goes', 'go', 'going',
    'came', 'comes', 'come', 'coming',
    'looked', 'looks', 'look', 'looking',
    'watched', 'watches', 'watch', 'watching',
    'turned', 'turns', 'turn', 'turning',
    'took', 'takes', 'take', 'taking',
    'put', 'puts', 'putting',
    'got', 'gets', 'get', 'getting',
    'held', 'holds', 'hold', 'holding',
    'pulled', 'pulls', 'pull', 'pulling',
    'pushed', 'pushes', 'push', 'pushing',
    'closed', 'closes', 'close', 'closing',
    'opened', 'opens', 'open', 'opening',
    'touched', 'touches', 'touch', 'touching',
    'sat', 'sits', 'sit', 'sitting',
    'stood', 'stands', 'stand', 'standing',
    'reached', 'reaches', 'reach', 'reaching',
    'stepped', 'steps', 'step', 'stepping',
    'placed', 'places', 'place', 'placing',
    'ate', 'eats', 'eat', 'eating',
    'drank', 'drinks', 'drink', 'drinking'
]);

/**
 * Verb plus adverb pairs where the adverb repeats the verb.
 *
 * Keyed by the adverb, valued by the verb STEMS it is redundant against. Stems,
 * because "whisper", "whispers", "whispered" and "whispering" are one fact, and
 * listing four forms of each is how a table like this develops holes.
 *
 * Every pair was checked in the direction that matters: is the sentence
 * strictly better with the adverb gone? If the adverb adds even a shade -
 * "shouted angrily" is not "shouted", anger is new information - it is not
 * redundant and it is not in this table.
 */
const REDUNDANT = {
    quietly: ['whisper', 'murmur', 'mumble', 'mutter', 'tiptoe'],
    softly: ['whisper', 'murmur'],
    silently: ['tiptoe', 'mouth'],
    loudly: ['shout', 'yell', 'scream', 'bellow', 'holler', 'roar', 'blare'],
    quickly: ['sprint', 'dash', 'race', 'rush', 'hurry', 'bolt', 'dart', 'scurry'],
    rapidly: ['sprint', 'dash', 'race', 'rush'],
    slowly: ['trudge', 'amble', 'saunter', 'dawdle', 'crawl', 'plod', 'shuffle'],
    suddenly: ['snap', 'jerk', 'lurch', 'startle'],
    angrily: ['snarl', 'seethe', 'fume'],
    happily: ['beam', 'rejoice'],
    sadly: ['weep', 'mourn', 'sob'],
    tightly: ['clench', 'grip', 'clutch', 'clasp'],
    firmly: ['grip', 'clench', 'clasp'],
    completely: ['destroy', 'annihilate', 'obliterate', 'demolish'],
    totally: ['destroy', 'annihilate', 'obliterate'],
    fully: ['complete', 'finish'],
    briefly: ['glance', 'skim'],
    closely: ['scrutinise', 'scrutinize', 'peer'],
    carefully: ['scrutinise', 'scrutinize'],
    forcefully: ['slam', 'shove', 'ram'],
    violently: ['slam', 'smash', 'ram'],
    gently: ['caress', 'stroke', 'nuzzle'],
    brightly: ['blaze', 'glare', 'gleam'],
    dimly: ['glimmer'],
    secretly: ['sneak'],
    unexpectedly: ['startle', 'ambush'],
    warmly: ['embrace', 'hug'],
    nervously: ['fidget'],
    hastily: ['rush', 'hurry', 'scramble']
};

/**
 * Every form of a verb that might be the table's key, for the REDUNDANT lookup.
 *
 * CANDIDATES, not one stem, and that is the whole point of the shape.
 *
 * ThesaurusService's rule - a stem under four letters is damage, so keep the
 * original - is right when the stem goes to Datamuse, because a bad stem there
 * returns confident nonsense. Applied here it silently LOSES matches instead:
 * "raced" strips to "rac", the guard hands back "raced", and "raced quickly"
 * stops being redundant even though "race" is sitting in the table. A closed
 * table cannot be poisoned by a short candidate - nothing in it is under four
 * letters - so the safe move is to offer every form and let the table decide.
 *
 * The 'e' variants are what catch the dropped-e spellings: race/raced,
 * amble/ambling, clutch/clutched.
 */
function stems(verb) {
    const word = String(verb || '').toLowerCase();
    const out = new Set([word]);

    const add = (value) => {
        if (value.length >= 3) {
            out.add(value);
            out.add(`${value}e`);
        }
    };

    if (word.endsWith('ied') && word.length > 4) add(`${word.slice(0, -3)}y`);
    if (word.endsWith('ing')) add(word.slice(0, -3));
    if (word.endsWith('ed')) add(word.slice(0, -2));
    if (word.endsWith('es')) add(word.slice(0, -2));
    if (word.endsWith('s') && !word.endsWith('ss')) add(word.slice(0, -1));

    return [...out];
}

/** Is this verb+adverb pair one where the verb already says it? */
function isRedundant(adverb, verb) {
    const verbs = REDUNDANT[String(adverb || '').toLowerCase()];
    if (!verbs || !verbs.length) return false;

    return stems(verb).some(candidate => verbs.includes(candidate));
}

/** Does this word look like a manner adverb? Morphology, not a list. */
function isAdverb(word) {
    const lower = String(word || '').toLowerCase();
    if (lower.length < 4) return false;
    if (!lower.endsWith('ly')) return false;
    return !NOT_ADVERB.has(lower);
}

module.exports = {
    KINDS, KIND_NOTES, NOT_ADVERB, SPEECH_VERBS, WEAK_VERBS, REDUNDANT,
    stems, isRedundant, isAdverb
};
