/**
 * CriticLenses
 *
 * The prose-craft instruction sets shared by both critic engines. Keeping them
 * in one place is what makes the local and cloud paths comparable: swapping the
 * engine changes who answers, never what was asked.
 *
 * These replaced the comic screenplay prompt the critic shipped with. The old
 * one asked about panel transitions and balloon voice; neither exists in prose.
 */

/*
 * `label` names the pass and `blurb` describes it, and the two do not repeat
 * each other. The labels used to be one word - "Critique", "Line edit" - which
 * told a writer choosing between them nothing, so the blurb had to carry the
 * distinction and was too long to sit beside the name in the rail. Naming the
 * pass for what it does moves that weight into the label and lets the blurb be
 * a tooltip.
 */
const LENSES = {
    critique: {
        id: 'critique',
        label: 'Structural read',
        blurb: 'Pacing, tension, character, and what is already working.',
        focus:
            'Assess this passage as a developmental editor would. Consider pacing and momentum, ' +
            'whether tension is built and paid off, whether characters read as distinct people, ' +
            'and whether the prose earns its length. Name what genuinely works, not only faults.'
    },
    line: {
        id: 'line',
        label: 'Sentence-level craft',
        blurb: 'Flabby phrasing, repetition, filter words, adverbs propping up weak verbs.',
        focus:
            'Assess this passage at sentence level. Look for repetition of words and sentence shapes, ' +
            'filter words that hold the reader at arm\'s length ("he felt", "she saw", "it seemed"), ' +
            'adverbs propping up weak verbs, clichés, and sentences that could carry more with less. ' +
            'Do not comment on plot or structure.'
    },
    continuity: {
        id: 'continuity',
        label: 'Contradictions',
        blurb: 'Facts, timeline, and established detail that disagree with each other.',
        focus:
            'Assess this passage for internal contradictions only: physical details that change, ' +
            'timeline problems, characters knowing things they were not told, objects or injuries ' +
            'that appear or vanish. Report only genuine contradictions visible in the text given. ' +
            'Do not comment on style, pacing, or quality.'
    }
};

const DEFAULT_LENS = 'critique';

function getLens(id) {
    return LENSES[id] || LENSES[DEFAULT_LENS];
}

function listLenses() {
    return Object.values(LENSES).map(({ id, label, blurb }) => ({ id, label, blurb }));
}

module.exports = { LENSES, DEFAULT_LENS, getLens, listLenses };
