// services/proofing/OveruseLexicon.js

/**
 * The words this scanner counts: intensifiers and absolutes.
 *
 * These are the words that turn the volume up without adding information. A
 * novelist does not overuse them on purpose - they arrive one at a time, each
 * one reasonable in its own sentence, and only become a tic when you can see
 * the whole book at once. That is the entire reason this feature exists, and
 * it is also why the list is FIXED rather than "whatever the model thinks".
 *
 * Counting is done here, locally, and not by a model. That is a deliberate
 * split and the same one MechanicsService made: asked "how many times does
 * 'very' appear", a language model estimates, and estimates plausibly - it
 * misses instances in long text and invents counts it never saw. A count that
 * is wrong is worse than no count, because the writer cannot tell. Regex over
 * the text is exhaustive by construction, instant, free and offline. The model
 * is asked the question it is actually good at, which is judgment: of these 34,
 * which are doing work?
 *
 * Every entry here is a word a good writer uses deliberately somewhere. Nothing
 * in this file is an error, and the scanner never calls it one - it reports a
 * rate and lets the writer look. "Never use 'very'" is advice for undergraduates.
 */

/**
 * Groups exist so the rail can switch a family off. A voice built on flat
 * absolute statement is a real voice, and a writer using it should be able to
 * silence that group rather than learn to ignore a panel.
 */
const GROUPS = {
    intensifier: 'Intensifiers',
    absolute: 'Absolutes',
    universal: 'Universals',
    hedge: 'Hedges'
};

/**
 * `word` is matched case-insensitively on word boundaries. Multi-word entries
 * are allowed and match across a single run of whitespace, so "kind of" still
 * matches when the writer broke the line between the two words.
 *
 * `note` is what the panel shows beside the word. It says what the word costs,
 * not that it is banned.
 */
const WORDS = [
    // --- Intensifiers: they modify an adjective instead of replacing it. ---
    { word: 'very', group: 'intensifier', note: 'Usually a weaker adjective asking for a stronger one.' },
    { word: 'really', group: 'intensifier', note: 'Adds emphasis in speech; on the page it mostly adds a word.' },
    { word: 'quite', group: 'intensifier', note: 'Hedge or intensifier depending on the reader - it is ambiguous either way.' },
    { word: 'rather', group: 'intensifier', note: 'Softens the adjective it is attached to.' },
    { word: 'extremely', group: 'intensifier', note: 'Reaches for scale the adjective could carry alone.' },
    { word: 'incredibly', group: 'intensifier', note: 'Literally "not to be believed", which is rarely the intent.' },
    { word: 'terribly', group: 'intensifier', note: 'Victorian intensifier; dates the narration if it is not deliberate.' },
    { word: 'awfully', group: 'intensifier', note: 'As above - period voice unless it is doing character work.' },
    { word: 'so', group: 'intensifier', note: 'Counted only as an intensifier ("so tired"), not as a conjunction.' },
    { word: 'too', group: 'intensifier', note: 'Excess marker; often the sentence already implies it.' },
    { word: 'pretty', group: 'intensifier', note: 'Conversational hedge - "pretty sure", "pretty good".' },
    { word: 'fairly', group: 'intensifier', note: 'Weakens the claim it modifies.' },
    { word: 'highly', group: 'intensifier', note: 'Reads as report language rather than prose.' },
    { word: 'truly', group: 'intensifier', note: 'Insists on a thing the sentence should demonstrate.' },
    { word: 'deeply', group: 'intensifier', note: 'Common with emotion words, where showing usually beats stating.' },
    { word: 'especially', group: 'intensifier', note: 'Fine in argument; in narration it often flags a list.' },
    { word: 'particularly', group: 'intensifier', note: 'Long word doing an intensifier\'s job.' },

    // --- Absolutes: they claim totality. ---
    { word: 'absolutely', group: 'absolute', note: 'Claims totality where the plain adjective is stronger.' },
    { word: 'completely', group: 'absolute', note: 'Most adjectives it attaches to are already absolute.' },
    { word: 'totally', group: 'absolute', note: 'Conversational absolute; strong voice marker in narration.' },
    { word: 'entirely', group: 'absolute', note: 'Formal absolute - watch the density in close third person.' },
    { word: 'utterly', group: 'absolute', note: 'High-register absolute; loses force fast on repetition.' },
    { word: 'perfectly', group: 'absolute', note: 'Often means "quite", which is the opposite of perfect.' },
    { word: 'perfect', group: 'absolute', note: 'An absolute judgment stated rather than shown.' },
    { word: 'literally', group: 'absolute', note: 'Rarely literal; when it is, it is usually not worth saying.' },
    { word: 'definitely', group: 'absolute', note: 'Certainty the scene should establish on its own.' },
    { word: 'certainly', group: 'absolute', note: 'As above - it tells the reader how sure to be.' },
    { word: 'undoubtedly', group: 'absolute', note: 'Asserts what the prose has not yet earned.' },
    { word: 'thoroughly', group: 'absolute', note: 'Completeness marker; usually cuttable.' },

    // --- Universals: every, always, never. Enormous claims, quietly made. ---
    { word: 'always', group: 'universal', note: 'A claim about all of time. Often means "often".' },
    { word: 'never', group: 'universal', note: 'As above, negated. Powerful when true and rare.' },
    { word: 'everyone', group: 'universal', note: 'Universal claim about people.' },
    { word: 'everybody', group: 'universal', note: 'As everyone.' },
    { word: 'everything', group: 'universal', note: 'Universal claim about things; often stands in for a detail.' },
    { word: 'nothing', group: 'universal', note: 'Absence stated wholesale rather than shown.' },
    { word: 'nobody', group: 'universal', note: 'Universal negative about people.' },
    { word: 'forever', group: 'universal', note: 'Rarely literal; loses force on repetition.' },
    { word: 'constantly', group: 'universal', note: 'Frequency claim that usually means "repeatedly".' },
    { word: 'endlessly', group: 'universal', note: 'As constantly, with more insistence.' },

    // --- Hedges: the opposite failure, and just as invisible. ---
    { word: 'just', group: 'hedge', note: 'The most invisible word on this list. Cut it and read the line again.' },
    { word: 'actually', group: 'hedge', note: 'Corrects an expectation the reader did not have.' },
    { word: 'basically', group: 'hedge', note: 'Signals approximation in prose that should be exact.' },
    { word: 'simply', group: 'hedge', note: 'Tells the reader a thing is easy, which can read as impatience.' },
    { word: 'almost', group: 'hedge', note: 'Withholds the thing itself. Dense runs read as evasive.' },
    { word: 'nearly', group: 'hedge', note: 'As almost.' },
    { word: 'practically', group: 'hedge', note: 'Approximation marker.' },
    { word: 'virtually', group: 'hedge', note: 'As practically, in a more formal register.' },
    { word: 'somewhat', group: 'hedge', note: 'Drains the adjective it modifies.' },
    { word: 'slightly', group: 'hedge', note: 'Fine once; a tic in description.' },
    { word: 'seemed', group: 'hedge', note: 'Distances the reader from what is happening.' },
    { word: 'kind of', group: 'hedge', note: 'Conversational hedge - strong in voice, weak in narration.' },
    { word: 'sort of', group: 'hedge', note: 'As kind of.' },
    { word: 'a bit', group: 'hedge', note: 'As kind of.' }
];

/*
 * "so" and "too" are the two entries that cannot be matched on the word alone.
 *
 * "So" is a conjunction far more often than an intensifier ("so she left"), and
 * "too" means "also" as often as "excessively" ("he came too"). Counting every
 * one would bury the real hits under noise and make the whole number
 * untrustworthy - which is the one thing a counter must not be. Both are
 * therefore only counted when followed by a word that an intensifier can
 * actually modify, which in practice means "not immediately followed by a
 * pronoun, an article, or a clause opener".
 */
const NOT_INTENSIFIED = new Set([
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'the', 'a', 'an', 'that', 'this',
    'these', 'those', 'there', 'then', 'when', 'if', 'what', 'who', 'his', 'her',
    'my', 'your', 'our', 'their', 'its', 'and', 'but', 'or', 'as', 'far', 'much',
    'many', 'long', 'do', 'did', 'was', 'were', 'is', 'are', 'had', 'has'
]);

const CONTEXTUAL = {
    so: (nextWord) => !!nextWord && !NOT_INTENSIFIED.has(nextWord),
    too: (nextWord) => !!nextWord && !NOT_INTENSIFIED.has(nextWord)
};

module.exports = { GROUPS, WORDS, CONTEXTUAL };
