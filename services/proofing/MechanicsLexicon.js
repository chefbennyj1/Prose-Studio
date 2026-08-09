/**
 * MechanicsLexicon
 *
 * The word lists the mechanics rules match against, kept apart from the rules
 * themselves so a rule reads as its logic rather than as a wall of vocabulary.
 *
 * These lists are the difference between a scanner that is useful on fiction
 * and one that cries wolf. Nearly every false positive a mechanical checker
 * produces on a novel comes from not knowing that "said" introduces speech and
 * "smiled" does not, or that "an hour" is correct and "an unicorn" is not.
 */

/**
 * Verbs that can introduce speech. A comma before the closing quote is correct
 * in front of these.
 *
 * Deliberately generous: a false member of this list costs a missed finding,
 * while a missing member costs a wrong one, and a wrong one on a correct line
 * is what teaches a writer to stop reading the panel.
 */
const SPEECH_VERBS = new Set([
    'said', 'says', 'say', 'asked', 'asks', 'ask', 'replied', 'replies',
    'answered', 'answers', 'whispered', 'whispers', 'shouted', 'shouts',
    'muttered', 'mutters', 'murmured', 'murmurs', 'cried', 'cries', 'called',
    'calls', 'yelled', 'yells', 'screamed', 'screams', 'growled', 'growls',
    'snapped', 'snaps', 'sighed', 'sighs', 'breathed', 'breathes', 'added',
    'adds', 'continued', 'continues', 'began', 'begins', 'explained',
    'explains', 'admitted', 'admits', 'agreed', 'agrees', 'argued', 'argues',
    'announced', 'announces', 'insisted', 'insists', 'offered', 'offers',
    'ordered', 'orders', 'promised', 'promises', 'protested', 'protests',
    'repeated', 'repeats', 'responded', 'responds', 'retorted', 'retorts',
    'roared', 'roars', 'sneered', 'sneers', 'stammered', 'stammers', 'stated',
    'states', 'suggested', 'suggests', 'told', 'tells', 'urged', 'urges',
    'warned', 'warns', 'wondered', 'wonders', 'mused', 'muses', 'observed',
    'observes', 'remarked', 'remarks', 'noted', 'notes', 'drawled', 'drawls',
    'barked', 'barks', 'hissed', 'hisses', 'spat', 'spits', 'purred', 'purrs',
    'demanded', 'demands', 'gasped', 'gasps', 'panted', 'pants', 'pleaded',
    'pleads', 'prompted', 'prompts', 'quipped', 'quips', 'rasped', 'rasps',
    'snarled', 'snarls', 'sobbed', 'sobs', 'wailed', 'wails', 'whimpered',
    'whimpers', 'croaked', 'croaks', 'boomed', 'booms', 'bellowed', 'bellows',
    'echoed', 'echoes', 'interrupted', 'interrupts', 'interjected', 'ventured',
    'ventures', 'conceded', 'concedes', 'countered', 'counters', 'confessed',
    'confesses', 'declared', 'declares', 'grumbled', 'grumbles', 'moaned',
    'moans', 'groaned', 'groans', 'chanted', 'recited', 'read', 'reads',
    'finished', 'concluded', 'guessed', 'joked', 'lied', 'reminded', 'teased',
    'whined', 'whines', 'sputtered', 'stuttered', 'blurted', 'mumbled',
    'mumbles', 'exclaimed', 'exclaims', 'commanded', 'corrected', 'clarified'
]);

/**
 * Verbs that cannot introduce speech, however often they are used that way.
 *
 * `"I know," he smiled.` is the single most common punctuation error in
 * amateur fiction: you cannot smile a sentence. The comma has to be a period.
 * Every entry here is a physical action rather than an utterance — and the
 * contested ones (chuckled, laughed, sighed) are handled by leaving the
 * arguable side out of SPEECH_VERBS rather than by asserting them here, so the
 * scanner never picks a fight it cannot win.
 */
const ACTION_VERBS = new Set([
    'smiled', 'smiles', 'laughed', 'laughs', 'grinned', 'grins', 'nodded',
    'nods', 'shrugged', 'shrugs', 'frowned', 'frowns', 'winced', 'winces',
    'blinked', 'blinks', 'scowled', 'scowls', 'giggled', 'giggles', 'snorted',
    'snorts', 'beamed', 'beams', 'gestured', 'gestures', 'sniffed', 'sniffs',
    'coughed', 'coughs', 'glared', 'glares', 'stared', 'stares', 'shivered',
    'shivers', 'pointed', 'points', 'waved', 'waves', 'shuddered', 'shudders',
    'grimaced', 'grimaces', 'yawned', 'yawns', 'blushed', 'blushes',
    'swallowed', 'swallows', 'winked', 'winks', 'flinched', 'flinches',
    'stiffened', 'stiffens', 'trembled', 'trembles', 'gulped', 'gulps'
]);

/**
 * Words that can carry tense on their own. Used only by the fragment rule, as
 * the cheapest available stand-in for "this clause has a finite verb".
 *
 * This is a heuristic and is treated as one: a fragment is reported as style,
 * never as an error, because fiction breaks sentences on purpose constantly
 * and a scanner that calls that a mistake is wrong more often than the writer.
 */
const FINITE_VERBS = new Set([
    // auxiliaries, copulas, modals
    'is', 'are', 'was', 'were', 'am', 'be', 'been', 'being', 'has', 'have',
    'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could', 'shall',
    'should', 'may', 'might', 'must', 'ought', 'need', 'dare',
    // contracted forms, after the apostrophe is stripped
    'isnt', 'arent', 'wasnt', 'werent', 'hasnt', 'havent', 'hadnt', 'dont',
    'doesnt', 'didnt', 'wont', 'wouldnt', 'cant', 'couldnt', 'shouldnt',
    'its', 'hes', 'shes', 'theyre', 'youre', 'im', 'weve', 'ive', 'thats',
    // irregular pasts common in narration
    'went', 'saw', 'knew', 'took', 'came', 'said', 'got', 'made', 'found',
    'thought', 'told', 'became', 'left', 'felt', 'put', 'brought', 'began',
    'kept', 'held', 'wrote', 'stood', 'heard', 'let', 'meant', 'set', 'met',
    'ran', 'paid', 'sat', 'spoke', 'lay', 'led', 'grew', 'lost', 'fell',
    'sent', 'built', 'understood', 'drew', 'broke', 'spent', 'cut', 'rose',
    'drove', 'bought', 'wore', 'chose', 'ate', 'drank', 'rode', 'shook',
    'threw', 'hit', 'hurt', 'struck', 'swung', 'slid', 'crept', 'knelt',
    'spun', 'tore', 'flung', 'clung', 'swept', 'wept', 'dug', 'hung', 'sank',
    'sprang', 'stuck', 'strode', 'swore', 'woke', 'won', 'wound', 'bent',
    'bled', 'blew', 'burst', 'caught', 'dealt', 'drew', 'fed', 'fought',
    'fled', 'flew', 'forgot', 'froze', 'gave', 'lit', 'made', 'read', 'rang',
    'shot', 'shut', 'sang', 'slept', 'slew', 'spread', 'sped', 'split',
    'stole', 'stung', 'taught', 'threw', 'wore', 'withdrew'
]);

/**
 * Words beginning with a vowel letter but a consonant sound, and the reverse.
 * "a" versus "an" follows the sound, not the spelling.
 */
const CONSONANT_SOUND = [
    'one', 'once', 'unicorn', 'uniform', 'union', 'unique', 'united', 'unit',
    'universal', 'universe', 'university', 'usable', 'usage', 'use', 'used',
    'useful', 'useless', 'user', 'usual', 'usually', 'utensil', 'utility',
    'european', 'euphemism', 'eulogy', 'ewe', 'ubiquitous', 'unanimous'
];

const VOWEL_SOUND = [
    'hour', 'hourly', 'honest', 'honestly', 'honesty', 'honor', 'honour',
    'honorable', 'honourable', 'heir', 'heiress', 'heirloom'
];

/** Comparatives that take "than". "more then" is always wrong. */
const COMPARATIVES = [
    'more', 'less', 'fewer', 'better', 'worse', 'greater', 'rather', 'other',
    'older', 'younger', 'larger', 'smaller', 'higher', 'lower', 'faster',
    'slower', 'longer', 'shorter', 'stronger', 'weaker', 'harder', 'easier',
    'closer', 'further', 'farther', 'deeper', 'wider', 'taller', 'richer',
    'sooner', 'later', 'nothing', 'else'
];

/**
 * Pronouns that can head an independent clause. The comma-splice rule is
 * restricted to these, which is what keeps it precise: "The rain fell, it was
 * cold" is a splice and detectable, while finding every splice with a full
 * noun-phrase subject needs a parser this deliberately is not.
 */
const CLAUSE_PRONOUNS = ['he', 'she', 'it', 'they', 'we', 'i', 'you'];

/**
 * Verbs that make a following clause parenthetical rather than spliced —
 * "She looked at him, he thought, and said nothing" is not a comma splice.
 */
const PARENTHETICAL_VERBS = new Set([
    'thought', 'said', 'knew', 'realised', 'realized', 'supposed', 'reckoned',
    'imagined', 'decided', 'admitted', 'guessed', 'suspected'
]);

/** Openers that are conjunctions, so the clause after the comma is subordinate. */
const CONJUNCTIONS = new Set([
    'and', 'but', 'or', 'nor', 'for', 'yet', 'so', 'because', 'although',
    'though', 'while', 'whereas', 'since', 'unless', 'until', 'if', 'when',
    'whenever', 'where', 'wherever', 'after', 'before', 'as', 'than', 'that'
]);

module.exports = {
    SPEECH_VERBS,
    ACTION_VERBS,
    FINITE_VERBS,
    CONSONANT_SOUND,
    VOWEL_SOUND,
    COMPARATIVES,
    CLAUSE_PRONOUNS,
    PARENTHETICAL_VERBS,
    CONJUNCTIONS
};
