/**
 * The writing-flags scanner.
 *
 * The first test is the one that matters most: the irregular-verb list is the
 * second half of a passive-voice pattern, NOT a word list. Flagged on its own
 * it would underline said, thought, made, put, found and held - most of the
 * verbs a novel is built from. If that test ever fails, the editor has started
 * underlining half of every page.
 */
import { readFileSync } from 'fs';
import { compile, scan } from '../views/dashboard/components/Editor/WritingFlags.js';

const data = JSON.parse(readFileSync(new URL('../resources/writing-flags.json', import.meta.url), 'utf8'));
const compiled = compile(data);
const all = new Set(Object.keys(data.categories));

let failures = 0;
const check = (name, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '\n      ' + detail : ''}`);
};
const flags = (text, only = all) => scan(text, compiled, { only });

// 1. Bare irregular participles are NOT flagged.
const plain = 'She said nothing. He thought about it, put the kettle on, and left. The letter he had made her read said little.';
const bare = flags(plain);
check('bare irregular verbs are not flagged', bare.length === 0,
    'flagged: ' + bare.map(h => `${h.category}:"${h.text}"`).join(', '));

// 2. But a real passive IS.
const passive = flags('The door was broken and the nets had been mended.');
check('auxiliary + participle is flagged as passive',
    passive.some(h => h.category === 'passiveVoice' && /was broken/i.test(h.text)),
    JSON.stringify(passive.map(h => h.text)));

// 3. An adverb between the two halves does not break it.
check('passive survives an adverb between the halves',
    flags('The vase was carefully broken.').some(h => h.category === 'passiveVoice'),
    'expected "was carefully broken"');

// 4. One span, one flag: the phrase wins over the word inside it.
const realm = flags('We work in the realm of the possible.');
check('the longest match wins over a word inside it',
    realm.filter(h => h.from < 20 && h.to > 10).length === 1 && realm.some(h => h.text.toLowerCase() === 'in the realm of'),
    JSON.stringify(realm.map(h => `${h.category}:"${h.text}"`)));

// 5. Abbreviations are support data and must never be flagged.
check('abbreviations are never flagged',
    flags('Dr. Ellis met Mr. Vance at 4 p.m., etc.').length === 0,
    JSON.stringify(flags('Dr. Ellis met Mr. Vance at 4 p.m., etc.').map(h => h.text)));

// 6. Category filtering actually filters.
const onlyWeasel = flags('It was very clearly a testament to her patience.', new Set(['weasel']));
check('the category filter excludes everything else',
    onlyWeasel.length > 0 && onlyWeasel.every(h => h.category === 'weasel'),
    JSON.stringify(onlyWeasel.map(h => h.category)));

// 7. Curly apostrophes match the straight ones in the list.
check('a curly apostrophe still matches',
    flags('In today\u2019s fast-paced world we begin.').some(h => h.category === 'aiPhrases'),
    'the editor turns straight quotes curly as you type');

// 8. Phrases match across a line break.
check('a phrase matches across a line break',
    flags('It was, to some\nextent, her doing.').some(h => /to some\s+extent/i.test(h.text)));

// 9. Hits come back sorted and non-overlapping - RangeSetBuilder throws otherwise.
const dense = flags('In today\u2019s fast-paced world, I think the implementation was very clearly a testament to it.');
let ordered = true;
for (let i = 1; i < dense.length; i++) if (dense[i].from < dense[i - 1].to) ordered = false;
check('hits are sorted and non-overlapping', ordered,
    JSON.stringify(dense.map(h => [h.from, h.to, h.text])));

// 10. Nominalizations carry the verb they want to be.
check('a nominalization carries its suggestion',
    flags('The implementation took a week.').some(h => h.suggestion === 'implement'));

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
process.exit(failures ? 1 : 0);
