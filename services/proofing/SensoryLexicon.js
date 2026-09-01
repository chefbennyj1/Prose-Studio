// services/proofing/SensoryLexicon.js

/**
 * The five senses, as words.
 *
 * WHAT THIS IS AND IS NOT. It is a proportion instrument, not a classifier.
 * Individual hits will be wrong - "bright idea" is not sight, "a cold stare" is
 * not touch - and that is tolerable, because the finding a writer acts on is
 * "eleven paragraphs in a row with no sound in them", which survives a good
 * deal of noise. Any claim finer than that is beyond a word list.
 *
 * A word may belong to more than one sense. Smoke is seen and smelled; a slam
 * is heard and felt. Forcing a single answer would be tidier and less true.
 *
 * DELIBERATELY NOT INCLUDED: emotion words. "She felt afraid" is not touch, and
 * a lexicon that counts it produces a chapter that looks rich in tactile
 * writing while containing none. The ambiguous verbs are gated below instead.
 */

const SIGHT = `
see sees saw seen seeing look looks looked looking watch watches watched
watching glance glanced glancing stare stared staring gaze gazed gazing
glimpse glimpsed peer peered squint squinted blink blinked notice noticed
observe observed regard regarded eye eyed
bright brightly brighter dark darker darkness dim dimly gloom gloomy shadow
shadows shadowed shade shaded glow glowed glowing gleam gleamed gleaming
glint glinted glitter glittered shine shines shone shining shimmer shimmered
sparkle sparkled flash flashed flashing flicker flickered flare flared
glare glared blaze blazed dazzle dazzled
colour color coloured colored pale paler pallid vivid faded washed
red green blue yellow white black grey gray silver golden crimson scarlet
amber violet pink orange brown
blur blurred blurry clear clearly visible invisible transparent opaque
silhouette outline shape shapes reflection reflected mirror
light lights lit unlit lantern lamp neon
`;

const SOUND = `
hear hears heard hearing listen listens listened listening
sound sounds sounded noise noises loud louder loudly quiet quieter quietly
silence silent silently hush hushed still stillness
echo echoed echoing whisper whispered whispering murmur murmured mutter
muttered mumble mumbled shout shouted shouting yell yelled scream screamed
screaming cry cried shriek shrieked call called
hum hummed humming buzz buzzed buzzing drone droned
click clicked clicking clatter clattered rattle rattled
crash crashed bang banged thud thudded thump thumped knock knocked
rustle rustled creak creaked groan groaned squeak squeaked
hiss hissed sizzle sizzled crackle crackled snap snapped pop popped
roar roared rumble rumbled thunder thundered boom boomed
ring rang ringing chime chimed toll tolled bell bells
footsteps footstep laugh laughed laughter sigh sighed gasp gasped
breath breathing panting wheeze wheezed
music song singing sang hummed melody rhythm
voice voices tone
`;

const SMELL = `
smell smells smelled smelt smelling scent scents scented
odour odor odours odors aroma aromas fragrance fragrant
stink stank stunk stinking stench reek reeked reeking
musty mildew mould mold rancid rotten rot rotting sour spoiled
acrid pungent sharpness sulphur sulfur ammonia bleach
perfume cologne incense
whiff waft wafted wafting breathe inhaled sniff sniffed sniffing
nostril nostrils
smoke smoky smoking soot ash
`;

const TASTE = `
taste tastes tasted tasting flavour flavor flavours flavors flavoured
bitter bitterness sweet sweetness sweeter sour salt salty savoury savory
tang tangy sharp metallic coppery
sip sipped sipping swallow swallowed swallowing gulp gulped
bite bit bitten chew chewed chewing lick licked
tongue palate mouthful
spice spiced spicy peppery sugary
`;

const TOUCH = `
touch touched touching feel feels felt feeling
rough roughness smooth smoothness soft softer softness hard hardness
cold colder coldness cool cooler chill chilled chilly freezing frozen ice icy
warm warmer warmth hot hotter heat scald scalded burn burned burnt scorching
wet wetter damp dampness soaked soaking dry drier parched
sharp jagged blunt prickle prickled sting stung
sticky slick slippery greasy gritty grainy dusty
grip gripped gripping grasp grasped clutch clutched squeeze squeezed
press pressed pressing push pushed pull pulled
brush brushed graze grazed scrape scraped scratch scratched
weight weighed heavy heavier heaviness light lightness
skin flesh fingers fingertips palm palms knuckles
shiver shivered shivering tremble trembled trembling
ache ached aching sore throb throbbed numb numbness
texture fabric velvet silk coarse
`;

/**
 * Ambiguous words, and the test that decides whether they count.
 *
 * Same device as OveruseService's CONTEXTUAL gate, and for the same reason: a
 * word that is sensory half the time is worse than useless uncounted, and
 * worse than useless counted blindly.
 *
 * Each entry is given the word that FOLLOWS the hit, lowercased.
 */
const EMOTIONS = new Set(`
afraid angry anxious ashamed bad better bitter calm certain confident confused
content cold cross depressed different disappointed embarrassed empty excited
foolish free glad good guilty happy helpless hopeful hopeless hurt ill jealous
lonely lost lucky mad nervous numb odd old proud ready relieved responsible
right sad safe scared secure sick silly small sorry strange strong stupid sure
surprised terrible tired uneasy unwell upset warm weak weird welcome worse
worried wrong young like
`.trim().split(/\s+/));

const CONTEXTUAL = {
    // "She felt afraid" is not touch. "She felt the wall" is.
    felt: next => !EMOTIONS.has(next),
    feel: next => !EMOTIONS.has(next),
    feels: next => !EMOTIONS.has(next),
    feeling: next => !EMOTIONS.has(next),
    // "It looked wrong" is judgement; "she looked up" is sight.
    looked: next => !EMOTIONS.has(next),
    looks: next => !EMOTIONS.has(next),
    // "A sharp remark" is not touch or taste.
    sharp: next => !['remark', 'reply', 'word', 'words', 'tone', 'wit', 'mind', 'eye', 'eyes'].includes(next),
    // "A taste for violence" is a preference, not a flavour.
    taste: next => next !== 'for',
    // "Cold comfort", "a cold stare" - the word is doing emotional work.
    cold: next => !['comfort', 'stare', 'look', 'silence', 'shoulder', 'truth', 'fact'].includes(next),
    warm: next => !['welcome', 'smile', 'regard', 'greeting', 'words'].includes(next),
    // "Sound advice", "sound asleep".
    sound: next => !['advice', 'asleep', 'judgement', 'judgment', 'reasoning'].includes(next),
    // "Light work", "light of the fact".
    light: next => !['work', 'touch', 'sleeper', 'years'].includes(next)
};

const SENSES = {
    sight: { label: 'Sight', words: toSet(SIGHT) },
    sound: { label: 'Sound', words: toSet(SOUND) },
    smell: { label: 'Smell', words: toSet(SMELL) },
    taste: { label: 'Taste', words: toSet(TASTE) },
    touch: { label: 'Touch', words: toSet(TOUCH) }
};

function toSet(block) {
    return new Set(block.trim().split(/\s+/));
}

/** Every sense a word belongs to. A word can be in more than one. */
function sensesFor(word) {
    const found = [];
    for (const [id, sense] of Object.entries(SENSES)) {
        if (sense.words.has(word)) found.push(id);
    }
    return found;
}

module.exports = { SENSES, CONTEXTUAL, sensesFor };
