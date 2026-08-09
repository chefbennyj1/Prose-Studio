/**
 * MechanicsRules
 *
 * The hand-rolled rules behind the mechanics scan: punctuation, dialogue
 * mechanics, the grammar errors that can be caught without a parser, and
 * paragraph layout.
 *
 * Why rules and not the model. The critic and SuggestionService already ask a
 * language model for judgment, and both pay for it — SuggestionService.verify()
 * exists entirely to throw away suggestions the model could not locate in the
 * text it was given. Mechanical faults do not need judgment. They need an exact
 * span, the same answer every time, and an answer now. That is a regex's job,
 * and doing it here means the scan is instant, free, offline, and produces
 * offsets that are correct by construction rather than by verification.
 *
 * Each rule is:
 *   id       stable key, used for the ignore list and the UI grouping
 *   label    what the writer reads
 *   group    punctuation | dialogue | grammar | structure
 *   severity error (a mistake) | style (a choice worth a second look)
 *   find(ctx) -> [{ offset, length, message, replacement?, severity? }]
 *
 * A rule returns offsets into the original document. `replacement` is the full
 * text that should stand in place of [offset, offset + length); omit it when
 * there is nothing a machine should presume to write, which is most of the
 * structure group.
 *
 * The bar for adding a rule: it must be wrong for a reason, not merely unusual.
 * Fiction breaks grammar deliberately and constantly — fragments, comma splices
 * in a character's voice, one-word paragraphs — so anything that a good writer
 * does on purpose is reported as `style` and says so, and anything ambiguous is
 * left out entirely. A scanner that cries wolf is one the writer stops reading.
 */

const {
    SPEECH_VERBS, ACTION_VERBS, FINITE_VERBS, CONSONANT_SOUND, VOWEL_SOUND,
    COMPARATIVES, CLAUSE_PRONOUNS, PARENTHETICAL_VERBS, CONJUNCTIONS
} = require('./MechanicsLexicon');

const { ABBREVIATIONS, ANY_DOUBLE } = require('./MechanicsText');

/* ---------- helpers ---------- */

/** Run a global regex and collect whatever the callback returns. */
function scan(pattern, text, build) {
    const out = [];
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    let match;
    while ((match = re.exec(text)) !== null) {
        if (match[0] === '') { re.lastIndex++; continue; }
        const item = build(match);
        if (Array.isArray(item)) out.push(...item);
        else if (item) out.push(item);
        // A zero-width lookahead match would otherwise spin forever.
        if (re.lastIndex === match.index) re.lastIndex++;
    }
    return out;
}

/** Offset of a capture group, given the match and the group's index. */
function groupOffset(match, index) {
    let offset = match.index;
    for (let i = 1; i < index; i++) offset += (match[i] || '').length;
    return offset;
}

/** Copy the capitalisation of `model` onto `word`. */
function matchCase(word, model) {
    if (!model) return word;
    if (model[0] === model[0].toUpperCase() && model[0] !== model[0].toLowerCase()) {
        return word[0].toUpperCase() + word.slice(1);
    }
    return word;
}

/** The next non-space run after `index`, capped so a rule cannot wander. */
function follower(text, index, span = 60) {
    let i = index;
    while (i < text.length && /[ \t]/.test(text[i])) i++;
    return { offset: i, text: text.slice(i, i + span) };
}

function words(text) {
    return text.toLowerCase().replace(/[’']/g, '').match(/[a-z]+/g) || [];
}

/** Does this clause carry a finite verb somewhere past its first word? */
function hasFiniteVerb(clause) {
    const list = words(clause);
    for (let i = 1; i < list.length; i++) {
        if (FINITE_VERBS.has(list[i])) return true;
        if (/[a-z]{3}ed$/.test(list[i])) return true;
    }
    return false;
}

const SUBORDINATORS = new Set([
    'when', 'while', 'although', 'though', 'because', 'if', 'as', 'after',
    'before', 'since', 'unless', 'until', 'whenever', 'wherever', 'whereas',
    'once', 'whether', 'despite', 'given'
]);

/* ---------- the rules ---------- */

const RULES = [

    /* ===== punctuation ===== */

    {
        id: 'double-space',
        label: 'Double space',
        group: 'punctuation',
        severity: 'style',
        blurb: 'More than one space between words.',
        find(ctx) {
            // Two spaces after a full stop is the typewriter convention, and a
            // manuscript that uses it everywhere is being consistent rather
            // than careless. So it is only reported when the document is
            // mostly single-spaced and these are the stragglers.
            const wide = (ctx.text.match(/[.!?][”"']?  [A-Z]/g) || []).length;
            const tight = (ctx.text.match(/[.!?][”"']? [A-Z]/g) || []).length;
            const sentenceGapsAreDeliberate = wide > tight;

            return scan(/(?<=\S)([ \t]{2,})(?=\S)/g, ctx.text, (m) => {
                const before = ctx.text[m.index - 1];
                const isSentenceGap = '.!?”"\''.includes(before);
                if (isSentenceGap && sentenceGapsAreDeliberate) return null;
                if (m[1].length === 2 && isSentenceGap && wide > 0 && !tight) return null;

                return {
                    offset: m.index,
                    length: m[1].length,
                    message: `${m[1].length} spaces where one belongs.`,
                    replacement: ' '
                };
            });
        }
    },

    {
        id: 'space-before-punctuation',
        label: 'Space before punctuation',
        group: 'punctuation',
        severity: 'error',
        blurb: 'A space sits between a word and the mark that follows it.',
        find(ctx) {
            const found = scan(/[ \t]+(?=[,;:!?])/g, ctx.text, (m) => ({
                offset: m.index,
                length: m[0].length,
                message: 'Punctuation attaches to the word before it.',
                replacement: ''
            }));

            // A full stop wants the same treatment, but " . . ." is a spaced
            // ellipsis and belongs to the repeated-punctuation rule, which has
            // a better answer for it than deleting one space.
            found.push(...scan(/[ \t]+(?=\.(?![ \t]*\.))/g, ctx.text, (m) => ({
                offset: m.index,
                length: m[0].length,
                message: 'A full stop attaches to the word before it.',
                replacement: ''
            })));

            return found;
        }
    },

    {
        id: 'missing-space-after-punctuation',
        label: 'Missing space after punctuation',
        group: 'punctuation',
        severity: 'error',
        blurb: 'A comma or full stop runs straight into the next word.',
        find(ctx) {
            const found = scan(/(?<=[a-zA-Z])([,;:])(?=[a-zA-Z])/g, ctx.text, (m) => ({
                offset: m.index,
                length: 1,
                message: 'A space belongs after this mark.',
                replacement: `${m[1]} `
            }));

            // Terminal marks need the abbreviation guard: "U.S.A" and "J.R.R."
            // are not missing anything.
            found.push(...scan(/([a-zA-Z]{2,})([.!?])(?=[A-Z])/g, ctx.text, (m) => {
                if (ABBREVIATIONS.has(m[1].toLowerCase())) return null;
                const offset = m.index + m[1].length;
                return {
                    offset,
                    length: 1,
                    message: 'A space belongs between these sentences.',
                    replacement: `${m[2]} `
                };
            }));

            return found;
        }
    },

    {
        id: 'repeated-punctuation',
        label: 'Repeated punctuation',
        group: 'punctuation',
        severity: 'style',
        blurb: 'The same mark twice over.',
        find(ctx) {
            const found = scan(/([!?,;:])\1+/g, ctx.text, (m) => ({
                offset: m.index,
                length: m[0].length,
                // Doubling a comma is a slip; doubling a bang is a decision,
                // and one worth being asked about rather than told off for.
                severity: ',;:'.includes(m[1]) ? 'error' : 'style',
                message: ',;:'.includes(m[1])
                    ? 'One mark is enough.'
                    : 'Repeated marks read as shouting on the page. One usually carries further.',
                replacement: m[1]
            }));

            found.push(...scan(/(?<![.…])\.\.(?![.])/g, ctx.text, (m) => ({
                offset: m.index,
                length: 2,
                severity: 'error',
                message: 'Two dots is neither a full stop nor an ellipsis.',
                replacement: '...'
            })));

            found.push(...scan(/\.{4,}/g, ctx.text, (m) => ({
                offset: m.index,
                length: m[0].length,
                severity: 'error',
                message: 'An ellipsis is three dots.',
                replacement: '...'
            })));

            found.push(...scan(/\.[ \t]+\.[ \t]+\./g, ctx.text, (m) => ({
                offset: m.index,
                length: m[0].length,
                severity: 'style',
                message: 'Spaced dots. Set as an ellipsis they will not break across a line.',
                replacement: '...'
            })));

            return found;
        }
    },

    {
        id: 'hyphen-for-dash',
        label: 'Hyphen doing a dash’s job',
        group: 'punctuation',
        severity: 'style',
        blurb: 'A hyphen or a double hyphen where an em dash belongs.',
        find(ctx) {
            // Spaced or unspaced is a house style, not a rule, so the
            // replacement copies whatever the manuscript already does most.
            const spaced = (ctx.text.match(/\s—\s/g) || []).length;
            const tight = (ctx.text.match(/\S—\S/g) || []).length;
            const dash = spaced > tight ? ' — ' : '—';

            const found = scan(/(?<=[a-zA-Z,])[ \t]+-[ \t]+(?=[a-zA-Z])/g, ctx.text, (m) => ({
                offset: m.index,
                length: m[0].length,
                message: 'A hyphen joins words; an em dash breaks a sentence.',
                replacement: dash
            }));

            found.push(...scan(/(?<!-)--(?!-)/g, ctx.text, (m) => ({
                offset: m.index,
                length: 2,
                message: 'Double hyphen is a typewriter’s em dash.',
                replacement: '—'
            })));

            return found;
        }
    },

    {
        id: 'straight-quotes',
        label: 'Straight quote marks',
        group: 'punctuation',
        severity: 'style',
        blurb: 'Typewriter quotes in a manuscript that otherwise uses curly ones.',
        find(ctx) {
            const curly = (ctx.text.match(/[“”]/g) || []).length;
            const straight = (ctx.text.match(/"/g) || []).length;

            // Only worth saying when the document has already committed to
            // curly marks and these are the ones that got missed. A manuscript
            // written entirely in straight quotes is internally consistent and
            // the typesetter will convert it.
            if (curly < 4 || straight === 0 || straight > curly) return [];

            return ctx.quotes.flatMap((span) => {
                const out = [];
                if (ctx.text[span.start] === '"') {
                    out.push({
                        offset: span.start,
                        length: 1,
                        message: 'Opening quote, set straight.',
                        replacement: '“'
                    });
                }
                if (span.closed && ctx.text[span.end - 1] === '"') {
                    out.push({
                        offset: span.end - 1,
                        length: 1,
                        message: 'Closing quote, set straight.',
                        replacement: '”'
                    });
                }
                return out;
            });
        }
    },

    {
        id: 'punctuation-outside-quote',
        label: 'Punctuation outside the quote',
        group: 'punctuation',
        severity: 'error',
        blurb: 'A comma or full stop parked after the closing quote mark.',
        find(ctx) {
            return ctx.quotes.flatMap((span) => {
                if (!span.closed) return [];
                const after = ctx.text[span.end];
                if (after !== ',' && after !== '.') return [];

                const quote = ctx.text[span.end - 1];
                return [{
                    offset: span.end - 1,
                    length: 2,
                    message: 'Commas and full stops go inside the closing quote.',
                    replacement: `${after}${quote}`
                }];
            });
        }
    },

    {
        id: 'unclosed-quote',
        label: 'Unclosed quote',
        group: 'punctuation',
        severity: 'error',
        blurb: 'A speech that opens and never closes.',
        find(ctx) {
            return ctx.quotes.flatMap((span) => {
                if (span.closed) return [];

                // A speech running on into the next paragraph deliberately
                // drops its closing mark and the next paragraph opens with a
                // fresh one. That is correct, and common, so it is not
                // reported — only a quote with no continuation is.
                const next = ctx.paragraphs.find(p => p.start > span.end);
                if (next && ANY_DOUBLE.includes(ctx.text[next.start])) return [];

                return [{
                    offset: span.start,
                    length: Math.min(40, span.end - span.start),
                    message: 'This quote is never closed. If the speech carries into the next paragraph, that one needs an opening mark.'
                }];
            });
        }
    },

    /* ===== dialogue ===== */

    {
        id: 'dialogue-tag-period',
        label: 'Full stop before a speech tag',
        group: 'dialogue',
        severity: 'error',
        blurb: '"I know." he said — the full stop should be a comma.',
        find(ctx) {
            return ctx.quotes.flatMap((span) => {
                if (!span.closed) return [];
                if (ctx.text[span.innerEnd - 1] !== '.') return [];

                const rest = follower(ctx.text, span.end);
                const tag = readTag(rest.text);
                if (!tag) return [];

                const period = span.innerEnd - 1;
                const quote = ctx.text[span.end - 1];

                // The tag's subject comes down to lower case with it: "He said"
                // is a fresh sentence, "he said" is the tag this now becomes.
                if (tag.headIsPronoun && tag.head[0] === tag.head[0].toUpperCase() && tag.head !== 'I') {
                    const end = rest.offset + tag.headEnd;
                    return [{
                        offset: period,
                        length: end - period,
                        message: 'A speech tag continues the sentence, so the speech ends on a comma and the tag stays lower case.',
                        replacement: `,${quote}${ctx.text.slice(span.end, rest.offset)}${tag.head.toLowerCase()}`
                    }];
                }

                return [{
                    offset: period,
                    length: 1,
                    message: `A speech tag continues the sentence — "${tag.verb}" needs a comma before it, not a full stop.`,
                    replacement: ','
                }];
            });
        }
    },

    {
        id: 'dialogue-tag-capital',
        label: 'Capitalised speech tag',
        group: 'dialogue',
        severity: 'error',
        blurb: '"I know," He said — the tag is part of the same sentence.',
        find(ctx) {
            return ctx.quotes.flatMap((span) => {
                if (!span.closed) return [];
                if (!',!?—'.includes(ctx.text[span.innerEnd - 1])) return [];

                const rest = follower(ctx.text, span.end);
                const tag = readTag(rest.text);
                if (!tag || !tag.headIsPronoun) return [];
                if (tag.head === 'I') return [];
                if (tag.head[0] !== tag.head[0].toUpperCase()) return [];

                return [{
                    offset: rest.offset,
                    length: tag.headEnd,
                    message: 'The tag belongs to the sentence the speech started, so it does not take a capital.',
                    replacement: tag.head.toLowerCase()
                }];
            });
        }
    },

    {
        id: 'dialogue-missing-comma',
        label: 'Missing comma before a speech tag',
        group: 'dialogue',
        severity: 'error',
        blurb: '"I know" he said — nothing separates the speech from the tag.',
        find(ctx) {
            return ctx.quotes.flatMap((span) => {
                if (!span.closed) return [];
                if (!/[a-zA-Z]/.test(ctx.text[span.innerEnd - 1] || '')) return [];

                const rest = follower(ctx.text, span.end);
                const tag = readTag(rest.text);
                if (!tag) return [];

                const last = span.innerEnd - 1;
                return [{
                    offset: last,
                    length: span.end - last,
                    message: 'A comma closes the speech before its tag.',
                    replacement: `${ctx.text[last]},${ctx.text[span.end - 1]}`
                }];
            });
        }
    },

    {
        id: 'dialogue-action-as-tag',
        label: 'Action used as a speech tag',
        group: 'dialogue',
        severity: 'error',
        blurb: '"I know," he smiled — you cannot smile a sentence.',
        find(ctx) {
            return ctx.quotes.flatMap((span) => {
                if (!span.closed) return [];
                if (ctx.text[span.innerEnd - 1] !== ',') return [];

                const rest = follower(ctx.text, span.end);
                const tag = readTag(rest.text, ACTION_VERBS);
                if (!tag) return [];

                const comma = span.innerEnd - 1;
                const quote = ctx.text[span.end - 1];
                const gap = ctx.text.slice(span.end, rest.offset);
                const message = `"${tag.verb}" is something the speaker does, not a way of speaking. Close the speech and let the action stand as its own sentence.`;

                // "smiled Marlow" cannot be repaired by swapping punctuation —
                // it needs rewriting to "Marlow smiled", which is the writer's
                // sentence to compose, not this scanner's. Report it and offer
                // nothing rather than propose a fix that reads worse.
                if (tag.order === 'verb-first') {
                    return [{ offset: comma, length: (rest.offset + tag.headEnd) - comma, message }];
                }

                return [{
                    offset: comma,
                    length: (rest.offset + tag.headEnd) - comma,
                    message,
                    replacement: `.${quote}${gap}${tag.head[0].toUpperCase()}${tag.head.slice(1)}`
                }];
            });
        }
    },

    {
        id: 'two-speakers-one-paragraph',
        label: 'Two speakers in one paragraph',
        group: 'dialogue',
        severity: 'style',
        blurb: 'A new speaker conventionally starts a new paragraph.',
        find(ctx) {
            return ctx.paragraphs.flatMap((paragraph) => {
                const spans = ctx.quotes.filter(q => q.start >= paragraph.start && q.end <= paragraph.end && q.closed);
                if (spans.length < 2) return [];

                const speakers = new Set();
                for (const span of spans) {
                    const tag = readTag(follower(ctx.text, span.end).text);
                    if (tag) speakers.add(tag.speaker);
                }
                if (speakers.size < 2) return [];

                return [{
                    offset: paragraph.start,
                    length: Math.min(60, paragraph.end - paragraph.start),
                    message: `${speakers.size} speakers share this paragraph. Convention gives each their own, so the reader can follow who is talking.`
                }];
            });
        }
    },

    /* ===== grammar ===== */

    {
        id: 'comma-splice',
        label: 'Comma splice',
        group: 'grammar',
        severity: 'error',
        blurb: 'Two complete sentences joined by a comma.',
        find(ctx) {
            const pronouns = CLAUSE_PRONOUNS.join('|');
            const pattern = new RegExp(`,[ \\t]+(${pronouns})[ \\t]+([a-z']+)`, 'gi');

            return scan(pattern, ctx.text, (m) => {
                const verb = m[2].toLowerCase().replace(/['’]/g, '');
                const isFinite = FINITE_VERBS.has(verb) || /[a-z]{3}ed$/.test(verb);
                if (!isFinite) return null;

                // "She looked at him, he thought, and said nothing." The second
                // clause is an aside, not a spliced sentence.
                const tail = ctx.text.slice(m.index + m[0].length, m.index + m[0].length + 12);
                if (PARENTHETICAL_VERBS.has(verb) && /^\s*[,.]/.test(tail)) return null;

                const sentence = ctx.sentences.find(s => m.index >= s.start && m.index < s.end);
                if (!sentence) return null;

                const before = ctx.text.slice(sentence.start, m.index);
                const first = (words(before)[0] || '');

                // "When the rain fell, he ran inside" opens with a subordinate
                // clause, so the comma is doing its job.
                if (SUBORDINATORS.has(first) || CONJUNCTIONS.has(first)) return null;

                // "Tired, he sat down" and "Exhausted and cold, he sat down"
                // have no finite verb ahead of the comma, so there is only one
                // sentence here and nothing to split.
                if (!hasFiniteVerb(before)) return null;

                return {
                    offset: m.index,
                    length: 1,
                    // Inside dialogue this is how people actually talk, so it
                    // is offered rather than corrected.
                    severity: ctx.inQuote(m.index) ? 'style' : 'error',
                    message: ctx.inQuote(m.index)
                        ? 'Two complete sentences joined by a comma. Inside speech that can be deliberate — worth a look.'
                        : 'Two complete sentences joined by a comma. Use a full stop, a semicolon, or a conjunction.',
                    replacement: ';'
                };
            });
        }
    },

    {
        id: 'could-of',
        label: '"could of" for "could have"',
        group: 'grammar',
        severity: 'error',
        blurb: 'A mishearing of the contraction "could’ve".',
        find(ctx) {
            return scan(/\b(could|should|would|must|might|may)([ \t]+)(of)\b/gi, ctx.text, (m) => ({
                offset: groupOffset(m, 3),
                length: m[3].length,
                severity: ctx.inQuote(m.index) ? 'style' : 'error',
                message: ctx.inQuote(m.index)
                    ? '"could of" is how it sounds, not how it is written. Keep it only if the voice is doing the work.'
                    : 'This is "could’ve" misheard. The word is "have".',
                replacement: matchCase('have', m[3])
            }));
        }
    },

    {
        id: 'a-versus-an',
        label: 'a / an',
        group: 'grammar',
        severity: 'error',
        blurb: 'The article follows the sound of the next word, not its spelling.',
        find(ctx) {
            const found = scan(/\b(a)([ \t]+)([aeiouAEIOU][a-zA-Z]*)/g, ctx.text, (m) => {
                if (CONSONANT_SOUND.includes(m[3].toLowerCase())) return null;
                return {
                    offset: m.index,
                    length: 1,
                    message: `"${m[3]}" opens on a vowel sound.`,
                    replacement: matchCase('an', m[1])
                };
            });

            found.push(...scan(/\b(an)([ \t]+)([b-df-hj-np-tv-zB-DF-HJ-NP-TV-Z][a-zA-Z]*)/g, ctx.text, (m) => {
                if (VOWEL_SOUND.includes(m[3].toLowerCase())) return null;
                return {
                    offset: m.index,
                    length: 2,
                    message: `"${m[3]}" opens on a consonant sound.`,
                    replacement: matchCase('a', m[1])
                };
            }));

            return found;
        }
    },

    {
        id: 'subject-verb-agreement',
        label: 'Subject and verb disagree',
        group: 'grammar',
        severity: 'error',
        blurb: '"they was", "he don’t", "there is three".',
        find(ctx) {
            const found = [];

            found.push(...scan(/\b(they|we|you)([ \t]+)(was)\b/gi, ctx.text, (m) => ({
                offset: groupOffset(m, 3),
                length: m[3].length,
                severity: ctx.inQuote(m.index) ? 'style' : 'error',
                message: `"${m[1]}" takes "were".`,
                replacement: matchCase('were', m[3])
            })));

            found.push(...scan(/\b(he|she|it)([ \t]+)(were)\b/gi, ctx.text, (m) => {
                // "If he were" and "wished he were" are the subjunctive and
                // are correct.
                const before = ctx.text.slice(Math.max(0, m.index - 24), m.index);
                if (/\b(if|wish|wished|wishes|though|unless|as)\s+$/i.test(before)) return null;
                return {
                    offset: groupOffset(m, 3),
                    length: m[3].length,
                    severity: ctx.inQuote(m.index) ? 'style' : 'error',
                    message: `"${m[1]}" takes "was".`,
                    replacement: matchCase('was', m[3])
                };
            }));

            found.push(...scan(/\b(he|she|it)([ \t]+)(don['’]t)\b/gi, ctx.text, (m) => ({
                offset: groupOffset(m, 3),
                length: m[3].length,
                severity: ctx.inQuote(m.index) ? 'style' : 'error',
                message: ctx.inQuote(m.index)
                    ? `"${m[1]} don’t" is dialect. Deliberate in a voice, a slip in narration.`
                    : `"${m[1]}" takes "doesn’t".`,
                replacement: matchCase('doesn’t', m[3])
            })));

            // Every part before the target is captured, because groupOffset
            // walks the groups to find where the target starts. An uncaptured
            // literal at the front shifts that sum and anchors the finding on
            // the wrong word.
            found.push(...scan(/\b(there)([ \t]+)(is|was)([ \t]+)(many|several|two|three|four|five|lots|numerous|dozens|hundreds)\b/gi, ctx.text, (m) => ({
                offset: groupOffset(m, 3),
                length: m[3].length,
                message: `"${m[5]}" is plural.`,
                replacement: matchCase(m[3].toLowerCase() === 'is' ? 'are' : 'were', m[3])
            })));

            return found;
        }
    },

    {
        id: 'confusable-words',
        label: 'Easily confused words',
        group: 'grammar',
        severity: 'error',
        blurb: 'then/than, its/it’s, your/you’re, whose/who’s.',
        find(ctx) {
            const found = [];
            const comparatives = COMPARATIVES.join('|');

            found.push(...scan(new RegExp(`\\b(${comparatives})([ \\t]+)(then)\\b`, 'gi'), ctx.text, (m) => ({
                offset: groupOffset(m, 3),
                length: m[3].length,
                message: 'A comparison takes "than". "Then" is about time.',
                replacement: matchCase('than', m[3])
            })));

            found.push(...scan(/\b(its)([ \t]+)(a|an|the|been|not|only|just|too|also|going|getting|becoming|about|because|still|always|never|hard|clear|obvious)\b/gi, ctx.text, (m) => ({
                offset: m.index,
                length: 3,
                message: '"It’s" is "it is". "Its" is the possessive.',
                replacement: matchCase('it’s', m[1])
            })));

            found.push(...scan(/\b(it['’]s)([ \t]+)(own|edge|edges|surface|way|place|head|eyes|walls|sides|weight|colour|color|shape|size|mouth|jaws|wings|feet|legs|skin)\b/gi, ctx.text, (m) => ({
                offset: m.index,
                length: m[1].length,
                message: 'The possessive is "its", with no apostrophe.',
                replacement: matchCase('its', m[1])
            })));

            found.push(...scan(/\b(your)([ \t]+)(welcome|going|getting|being|doing|not|gonna|never)\b/gi, ctx.text, (m) => ({
                offset: m.index,
                length: 4,
                message: '"You’re" is "you are".',
                replacement: matchCase('you’re', m[1])
            })));

            found.push(...scan(/\b(you['’]re)([ \t]+)(own|turn|name|face|hand|hands|house|car|fault|job|point|father|mother|brother|sister)\b/gi, ctx.text, (m) => ({
                offset: m.index,
                length: m[1].length,
                message: 'The possessive is "your".',
                replacement: matchCase('your', m[1])
            })));

            found.push(...scan(/\b(whose)([ \t]+)(going|coming|gonna|been|got|there)\b/gi, ctx.text, (m) => ({
                offset: m.index,
                length: 5,
                message: '"Who’s" is "who is".',
                replacement: matchCase('who’s', m[1])
            })));

            found.push(...scan(/\b(alot)\b/gi, ctx.text, (m) => ({
                offset: m.index,
                length: 4,
                message: 'Two words.',
                replacement: matchCase('a lot', m[1])
            })));

            // The apostrophe on the wrong side of the n't.
            found.push(...scan(/\b([a-z]+)(['’])(nt)\b/gi, ctx.text, (m) => ({
                offset: m.index,
                length: m[0].length,
                message: 'The apostrophe stands in for the "o" of "not".',
                replacement: `${m[1]}n’t`
            })));

            return found;
        }
    },

    {
        id: 'double-negative',
        label: 'Double negative',
        group: 'grammar',
        severity: 'style',
        blurb: 'Two negatives in one clause.',
        find(ctx) {
            return scan(/\b(didn|doesn|don|couldn|wouldn|can|won|haven|hasn|ain)['’]t[ \t]+(?:[a-z'’]+[ \t]+){0,2}(no|nothing|nobody|none|nowhere|never)\b/gi, ctx.text, (m) => ({
                offset: m.index,
                length: m[0].length,
                message: ctx.inQuote(m.index)
                    ? 'A double negative. In a character’s mouth that is a voice; in narration it is a slip.'
                    : 'Two negatives cancel. "Didn’t have any" is likely what was meant.'
            }));
        }
    },

    {
        id: 'repeated-word',
        label: 'Word typed twice',
        group: 'grammar',
        severity: 'error',
        blurb: 'The same word twice in a row.',
        find(ctx) {
            // Legitimately doubled in English, or doubled on purpose for
            // emphasis, which is a thing people do out loud.
            const allowed = new Set(['had', 'that', 'no', 'never', 'very', 'really', 'so', 'again', 'now', 'yes']);

            // Case-insensitive, because the pair that actually gets typed is
            // "The the" at the start of a sentence, and a case-sensitive
            // backreference is exactly the one that misses it.
            return scan(/\b([A-Za-z][A-Za-z'’]*)([ \t]+|[ \t]*\n[ \t]*)(\1)\b/gi, ctx.text, (m) => {
                if (allowed.has(m[1].toLowerCase())) return null;
                // A sentence boundary between them means these are two words,
                // not one typed twice.
                if (/[.!?]/.test(m[2])) return null;

                return {
                    offset: m.index,
                    length: m[0].length,
                    severity: ctx.inQuote(m.index) ? 'style' : 'error',
                    message: `"${m[1]}" appears twice in a row.`,
                    replacement: m[1]
                };
            });
        }
    },

    {
        id: 'missing-capital',
        label: 'Sentence starts lower case',
        group: 'grammar',
        severity: 'error',
        blurb: 'A full stop, then a lower-case letter.',
        find(ctx) {
            return scan(/([a-zA-Z]+)([.!?])([ \t]+)([a-z])/g, ctx.text, (m) => {
                if (ABBREVIATIONS.has(m[1].toLowerCase())) return null;
                if (m[1].length === 1 && m[1] === m[1].toUpperCase()) return null;

                const offset = m.index + m[1].length + m[2].length + m[3].length;
                return {
                    offset,
                    length: 1,
                    message: 'A new sentence takes a capital.',
                    replacement: m[4].toUpperCase()
                };
            });
        }
    },

    {
        id: 'sentence-fragment',
        label: 'Fragment',
        group: 'grammar',
        severity: 'style',
        blurb: 'A sentence with no verb holding it together.',
        find(ctx) {
            return ctx.sentences.flatMap((sentence) => {
                const list = words(sentence.text);

                // Short fragments are the deliberate kind — "Nothing." "Not
                // yet." — and flagging those would bury everything else.
                if (list.length < 5 || list.length > 25) return [];
                if (hasFiniteVerb(sentence.text)) return [];
                if (FINITE_VERBS.has(list[0])) return [];

                // Dialogue is speech, and speech is fragments.
                if (ctx.inQuote(sentence.start)) return [];

                return [{
                    offset: sentence.start,
                    length: sentence.end - sentence.start,
                    message: 'No finite verb here, so this reads as a fragment. Deliberate fragments are good prose — this one is only worth a second look.'
                }];
            });
        }
    },

    /* ===== structure ===== */

    {
        id: 'long-sentence',
        label: 'Long sentence',
        group: 'structure',
        severity: 'style',
        blurb: 'A sentence past the length a reader holds in one breath.',
        find(ctx) {
            const limit = ctx.options.longSentenceWords;
            return ctx.sentences.flatMap((sentence) => {
                const count = words(sentence.text).length;
                if (count <= limit) return [];
                return [{
                    offset: sentence.start,
                    length: sentence.end - sentence.start,
                    message: `${count} words. Long sentences can carry weight, but check this one is carrying it on purpose.`
                }];
            });
        }
    },

    {
        id: 'long-paragraph',
        label: 'Long paragraph',
        group: 'structure',
        severity: 'style',
        blurb: 'A paragraph a reader sees as a wall before they read a word of it.',
        find(ctx) {
            const limit = ctx.options.longParagraphWords;
            return ctx.paragraphs.flatMap((paragraph) => {
                const count = words(paragraph.text).length;
                if (count <= limit) return [];
                return [{
                    offset: paragraph.start,
                    length: Math.min(80, paragraph.end - paragraph.start),
                    message: `${count} words in one paragraph. The page reads as a block before the reader starts.`
                }];
            });
        }
    },

    {
        id: 'repeated-opener',
        label: 'Sentences opening the same way',
        group: 'structure',
        severity: 'style',
        blurb: 'A run of sentences starting on the same word.',
        find(ctx) {
            const limit = ctx.options.openerRun;
            const out = [];

            for (const paragraph of ctx.paragraphs) {
                const sentences = ctx.sentences.filter(s => s.start >= paragraph.start && s.end <= paragraph.end);

                let run = [];
                const flush = () => {
                    if (run.length >= limit) {
                        const opener = words(run[0].text)[0];
                        out.push({
                            offset: run[0].start,
                            length: Math.min(70, run[run.length - 1].end - run[0].start),
                            message: `${run.length} sentences in a row open on "${opener}". The rhythm starts to show.`
                        });
                    }
                    run = [];
                };

                for (const sentence of sentences) {
                    const opener = words(sentence.text)[0];
                    if (!opener) { flush(); continue; }
                    if (run.length && words(run[0].text)[0] === opener) run.push(sentence);
                    else { flush(); run = [sentence]; }
                }
                flush();
            }

            return out;
        }
    },

    {
        id: 'trailing-whitespace',
        label: 'Trailing space',
        group: 'structure',
        severity: 'style',
        blurb: 'Spaces left at the end of a line.',
        find(ctx) {
            return scan(/[ \t]+$/gm, ctx.text, (m) => ({
                offset: m.index,
                length: m[0].length,
                message: 'Invisible here, but it survives into an export.',
                replacement: ''
            }));
        }
    }
];

/**
 * Read a speech tag sitting after a closing quote.
 *
 * Handles both orders — "he said" and "said Marlow" — because both are correct
 * and only one of them puts the speaker first.
 *
 * `head` and `speaker` are deliberately separate. `head` is the first word
 * after the quote, which is the one a fix has to re-case; `speaker` is who is
 * talking, which is what the two-speakers rule counts. In "said Marlow" those
 * are different words, and treating them as one made every verb-first tag in a
 * paragraph report the same speaker — "said" — so a paragraph where Marlow and
 * Chen both spoke looked like a single voice.
 *
 * @param {string} text   Text immediately following the closing quote.
 * @param {Set}    verbs  Which verb list counts. Defaults to speech verbs;
 *                        the action rule passes the list of verbs that cannot
 *                        introduce speech at all.
 */
function readTag(text, verbs = SPEECH_VERBS) {
    const speakerFirst = text.match(/^([A-Za-z][a-z'’]*)[ \t]+([a-z'’]+)/);
    if (speakerFirst && verbs.has(speakerFirst[2].toLowerCase())) {
        return {
            head: speakerFirst[1],
            headEnd: speakerFirst[1].length,
            headIsPronoun: isPronoun(speakerFirst[1]),
            speaker: speakerFirst[1].toLowerCase(),
            verb: speakerFirst[2],
            order: 'speaker-first'
        };
    }

    const verbFirst = text.match(/^([a-z'’]+)[ \t]+([A-Z][a-z'’]*)/);
    if (verbFirst && verbs.has(verbFirst[1].toLowerCase())) {
        return {
            head: verbFirst[1],
            headEnd: verbFirst[1].length,
            headIsPronoun: false,
            speaker: verbFirst[2].toLowerCase(),
            verb: verbFirst[1],
            order: 'verb-first'
        };
    }

    return null;
}

function isPronoun(word) {
    return ['he', 'she', 'they', 'it', 'i', 'we', 'you'].includes(word.toLowerCase());
}

const GROUPS = {
    punctuation: 'Punctuation',
    dialogue: 'Dialogue',
    grammar: 'Grammar',
    structure: 'Structure'
};

module.exports = { RULES, GROUPS };
