// views/dashboard/components/Editor/PageBreaks.js

/**
 * The page rules behind the manuscript, and the page number on each one.
 *
 * ## Pages are computed, never stored
 *
 * Nothing about a page is written to the .md file, and that is not a detail —
 * it is the same decision ManuscriptService already made and explains: a
 * chapter is ONE file, and prose reflows as it is edited, so a boundary written
 * into the text is wrong the moment a word above it changes. Storing them would
 * also put a marker in the writer's Markdown that the adverb scan, the word
 * cloud, the spellchecker and above all the NARRATOR would each have to know to
 * ignore — and the one that forgot would read "page seven" out loud.
 *
 * ## Anchored to words, not to pixels
 *
 * The previous implementation drew a repeating background gradient every
 * `--page-height` pixels, where that height came from an estimate: usable width
 * divided by an assumed 0.5em average glyph, divided by an assumed 5.7
 * characters per word. Two things were wrong with it, and they are the two
 * things this file exists to fix.
 *
 * A gradient is paint, so it knows nothing about the text. A rule landed
 * wherever its pixel fell and the line of prose there sat straight across it.
 * There was no element at the break, so there was nowhere to put breathing
 * room and nowhere to put a number.
 *
 * And a pixel height depends on the WINDOW. Resizing changed the estimate,
 * which moved every rule in the chapter, while the page count in the header —
 * computed from words — did not move at all. The two could disagree and
 * nothing said so.
 *
 * Here a break belongs to a position in the document: after the word that ends
 * page N. Rewrapping the prose moves the words on screen and the break travels
 * with them, so there is nothing to recompute when the window changes size.
 *
 * ## Why the count can never drift from the header
 *
 * The number of pages is decided FIRST, from the same arithmetic the server
 * uses — ceil(words / pageWords) — and the breaks are then placed to match it.
 * The rules are a consequence of the count rather than a second opinion about
 * it, so "Page 7" at the bottom of the screen and "8 pages" in the header
 * cannot contradict each other.
 *
 * ## Where a break is allowed to fall
 *
 * Between lines, because that is where a block widget can go — and in Markdown
 * a paragraph is one line. So a rule lands at the paragraph boundary nearest
 * its target word rather than exactly on it, which is also how a real page
 * breaks: between lines, never through one.
 *
 * A paragraph longer than a whole page therefore gets its rule at the end
 * rather than inside. That is accepted deliberately. The alternative is a line
 * drawn through the middle of a sentence, and a rule that lands a paragraph
 * late is a smaller lie than that.
 */

import { Decoration, WidgetType, StateField, StateEffect, EditorView } from '/libs/codemirror/codemirror.js';

/**
 * Words on a page. 250 is standard manuscript format — double-spaced, 12pt
 * Courier — which is what agents and editors count in.
 *
 * Only a fallback: the real number arrives from the server, which reads it from
 * ManuscriptService, so there is ONE definition of a page in the app. The
 * editor used to keep its own copy of 250 with a comment asking whoever changed
 * it to remember this one too.
 */
export const FALLBACK_PAGE_WORDS = 250;

/** Sets the words-per-page the server reported. */
export const setPageWords = StateEffect.define();

/**
 * The rule itself.
 *
 * The number is the page that has just ENDED, so it reads as the footer of the
 * page above it — which is where a writer looks to answer "what page am I on".
 */
class PageBreakWidget extends WidgetType {
    constructor(page) {
        super();
        this.page = page;
    }

    /**
     * Widgets compare equal when they would render identically, and this is
     * what stops every rule below an edit being torn down and rebuilt on each
     * keystroke — only the ones whose NUMBER changed are redrawn.
     */
    eq(other) {
        return other.page === this.page;
    }

    toDOM() {
        const wrap = document.createElement('div');
        wrap.className = 'cm-pageBreak';
        // Decorative: the rule is a visual aid, and a screen reader announcing
        // "Page 3" between two paragraphs would interrupt the prose being read.
        wrap.setAttribute('aria-hidden', 'true');

        const label = document.createElement('span');
        label.className = 'cm-pageBreak__label';
        label.textContent = `Page ${this.page}`;
        wrap.appendChild(label);

        return wrap;
    }

    /** Nothing in here is interactive; let clicks reach the editor. */
    ignoreEvent() {
        return false;
    }
}

function countWords(text) {
    const trimmed = text.trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).length;
}

/**
 * Where every page ends, as document positions.
 *
 * One pass to collect the running word count at each line boundary, then one
 * pass per page to pick the boundary nearest that page's target. A chapter has
 * a few hundred lines, so this is cheap enough to do on every edit without a
 * debounce — and being exact matters more than being clever, because the number
 * printed on the rule is a claim.
 */
function pageBreakPositions(doc, pageWords) {
    const totalWords = countWords(doc.toString());
    const pages = Math.max(1, Math.ceil(totalWords / pageWords));
    if (pages < 2) return [];

    // Running total at the END of each line. Position 0 is excluded: a break
    // before the first word is not a page.
    const boundaries = [];
    let running = 0;

    for (let lineNo = 1; lineNo <= doc.lines; lineNo++) {
        const line = doc.line(lineNo);
        running += countWords(line.text);
        // The last line's end is the end of the document, which is not a break
        // either — there is no page after it.
        if (lineNo < doc.lines) boundaries.push({ pos: line.to, words: running });
    }

    if (!boundaries.length) return [];

    const breaks = [];
    let searchFrom = 0;

    for (let page = 1; page < pages; page++) {
        const target = page * pageWords;

        // Boundaries are in ascending word order, so the search can carry on
        // from where the last page left off.
        let best = searchFrom;
        for (let i = searchFrom; i < boundaries.length; i++) {
            const closer = Math.abs(boundaries[i].words - target) < Math.abs(boundaries[best].words - target);
            if (closer) best = i;
            // Past the target and getting worse: nothing further can be nearer.
            if (boundaries[i].words >= target) break;
        }

        const chosen = boundaries[best];

        // A paragraph longer than a page can be the nearest boundary to two
        // targets. Drawing two rules in the same place would stack them, so the
        // page simply has no rule of its own — see the note at the top.
        if (!breaks.length || breaks[breaks.length - 1].pos !== chosen.pos) {
            breaks.push({ pos: chosen.pos, page });
        }

        searchFrom = best + 1;
        if (searchFrom >= boundaries.length) break;
    }

    return breaks;
}

function buildDecorations(state, pageWords) {
    const breaks = pageBreakPositions(state.doc, pageWords);
    if (!breaks.length) return Decoration.none;

    return Decoration.set(breaks.map(({ pos, page }) =>
        Decoration.widget({
            widget: new PageBreakWidget(page),
            // A block widget, so it sits BETWEEN lines and takes real vertical
            // space. That is the whole point: an inline widget would be dropped
            // into the middle of a paragraph mid-sentence.
            block: true,
            // After the line it is attached to, not before it.
            side: 1
        }).range(pos)
    ), true);
}

/**
 * Block widgets change the vertical layout, so these decorations MUST come
 * from a state field. A view plugin only knows about the viewport, and heights
 * above it would be wrong — CodeMirror would mis-measure the scrollbar and the
 * document would jump as it was scrolled.
 */
export const pageBreakField = StateField.define({
    create(state) {
        return {
            pageWords: FALLBACK_PAGE_WORDS,
            decorations: buildDecorations(state, FALLBACK_PAGE_WORDS)
        };
    },

    update(value, tr) {
        let { pageWords } = value;
        let changed = false;

        for (const effect of tr.effects) {
            if (effect.is(setPageWords)) {
                const next = Number(effect.value);
                if (next > 0 && next !== pageWords) {
                    pageWords = next;
                    changed = true;
                }
            }
        }

        if (!tr.docChanged && !changed) return value;

        return { pageWords, decorations: buildDecorations(tr.state, pageWords) };
    },

    provide: field => EditorView.decorations.from(field, value => value.decorations)
});

/** For the standalone check, which has no editor to build. */
export const __test__ = { pageBreakPositions, countWords };
