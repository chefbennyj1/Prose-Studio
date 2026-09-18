// views/dashboard/components/Editor/Surface.js

/**
 * The writing surface, on CodeMirror 6.
 *
 * Everything the editor needs from the surface goes through this file, in the
 * shape a textarea had: get the text, set the text, where is the selection,
 * put the selection there. That is deliberate. Editor.js should not know what
 * is underneath it, and the previous surface WAS a textarea - keeping the seam
 * narrow is what let this be swapped without rewriting the editor around it,
 * and what would let it be swapped again.
 *
 * Why CodeMirror rather than the textarea it replaces:
 *   - line numbers that stay correct when a paragraph reflows, which a
 *     textarea cannot do at all: it does not expose where its lines sit
 *   - the Markdown you typed stays visible as Markdown, but headings and
 *     emphasis are styled as you write them
 *   - a real undo history that survives edits applied on the writer's behalf
 *
 * What it costs, honestly: CodeMirror renders into a contenteditable, so the
 * browser's spellchecker has to be switched on here rather than coming free
 * with the element, and only the lines currently on screen exist in the DOM.
 *
 * Numbers appear ONLY on lines with words on them. The count still includes
 * blank lines - it has to, because SpellService reports findings as "line 47"
 * counting every \n - so numbers run 1, 3, 5 down the margin instead of
 * putting one against every empty row between paragraphs.
 */

import {
    EditorView, keymap, lineNumbers, placeholder as placeholderExt, drawSelection,
    EditorState,
    defaultKeymap, history, historyKeymap,
    markdown, markdownLanguage,
    syntaxHighlighting, HighlightStyle,
    tags,
    search, searchKeymap,
    Decoration, ViewPlugin, StateField, StateEffect, RangeSetBuilder
} from '/libs/codemirror/codemirror.js';

// The writing-flags scanner. Named on import because `search` above is already
// CodeMirror's, and a bare `scan` here would read as if it were CodeMirror's too.
import { scan as scanFlags } from './WritingFlags.js';

// The page rules and their numbers. Anchored to words rather than pixels, so
// they survive a resize without being recomputed — see PageBreaks.js.
import { pageBreakField, setPageWords as setPageWordsEffect } from './PageBreaks.js';

/**
 * Tags map to class names rather than inline styles, so the appearance lives
 * in Editor.css with the rest of the editor's look instead of in here.
 */
const proseHighlight = HighlightStyle.define([
    { tag: tags.heading1, class: 'md-h1' },
    { tag: tags.heading2, class: 'md-h2' },
    { tag: tags.heading3, class: 'md-h3' },
    { tag: tags.heading4, class: 'md-h4' },
    { tag: tags.heading5, class: 'md-h5' },
    { tag: tags.heading6, class: 'md-h6' },
    { tag: tags.strong, class: 'md-strong' },
    { tag: tags.emphasis, class: 'md-em' },
    { tag: tags.strikethrough, class: 'md-strike' },
    { tag: tags.link, class: 'md-link' },
    { tag: tags.url, class: 'md-url' },
    { tag: tags.quote, class: 'md-quote' },
    { tag: tags.monospace, class: 'md-code' },
    { tag: tags.contentSeparator, class: 'md-rule' },
    { tag: tags.processingInstruction, class: 'md-mark' }
]);

/** A line with nothing but whitespace on it gets no number. */
function formatNumber(lineNo, state) {
    if (lineNo > state.doc.lines) return '';
    return state.doc.line(lineNo).text.trim() ? String(lineNo) : '';
}

/*
 * ---------- formatting commands ----------
 *
 * These write Markdown into the document, because the document IS Markdown and
 * that is load-bearing rather than incidental: the file on disk is what Git
 * backs up and diffs, what MechanicsService anchors its findings into by
 * character offset, and what the narrator reads.
 *
 * So the commands here are the SEMANTIC ones only — italic, bold, headings,
 * scene breaks, quotes. There is deliberately no font, size, colour or
 * alignment. Those describe how text looks rather than what it is, Markdown
 * cannot carry them, and a manuscript should not: standard format is one font,
 * double-spaced, which is the same assumption the 250-words-a-page count in
 * Editor.js already rests on.
 */

/**
 * Wrap the selection in a marker, or take the marker off if it is already
 * there. Toggling matters: a writer who italicises a word, looks at it and
 * changes their mind will press the same button again, and getting `**text**`
 * out of that would be its own bug.
 *
 * With nothing selected it inserts the pair and puts the caret between them,
 * so typing continues inside the emphasis.
 */
function toggleWrap(view, marker) {
    const { state } = view;
    const range = state.selection.main;
    const len = marker.length;

    const selected = state.sliceDoc(range.from, range.to);
    const char = marker[0];

    /*
     * Is this marker part of a longer run of the same character?
     *
     * Italic is `*` and bold is `**`, so without this check pressing Italic on
     * bold text matches the outer asterisk of each `**`, strips one from each
     * side, and silently turns `**bold**` into `*italic*` — a formatting change
     * the writer never asked for, applied to text they were only toggling.
     */
    const runsOn = (index) => state.sliceDoc(Math.max(0, index), Math.max(0, index) + 1) === char;

    // Already wrapped, inside the selection: "*word*" -> "word"
    if (selected.length >= len * 2 && selected.startsWith(marker) && selected.endsWith(marker)
        && selected[len] !== char && selected[selected.length - len - 1] !== char) {
        const inner = selected.slice(len, -len);
        view.dispatch({
            changes: { from: range.from, to: range.to, insert: inner },
            selection: { anchor: range.from, head: range.from + inner.length }
        });
        return true;
    }

    // Already wrapped, just outside the selection: "*[word]*" -> "word"
    const before = state.sliceDoc(Math.max(0, range.from - len), range.from);
    const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + len));
    if (before === marker && after === marker
        && !runsOn(range.from - len - 1) && !runsOn(range.to + len)) {
        view.dispatch({
            changes: [
                { from: range.from - len, to: range.from },
                { from: range.to, to: range.to + len }
            ],
            selection: { anchor: range.from - len, head: range.to - len }
        });
        return true;
    }

    view.dispatch({
        changes: { from: range.from, to: range.to, insert: `${marker}${selected}${marker}` },
        selection: selected
            ? { anchor: range.from + len, head: range.from + len + selected.length }
            : { anchor: range.from + len }
    });
    return true;
}

/**
 * Put a prefix on the current line, or take it off again — "## " for a
 * heading, "> " for a quote. Any existing prefix of the same family is
 * replaced, so a level-two heading becomes a level-three rather than "## ## ".
 */
function toggleLinePrefix(view, prefix) {
    const { state } = view;
    const line = state.doc.lineAt(state.selection.main.head);

    const existing = line.text.match(/^(#{1,6}\s+|>\s+)/);
    const current = existing ? existing[1] : '';

    // Same prefix again means "undo this".
    const insert = current.trimEnd() === prefix.trimEnd() ? '' : prefix;

    view.dispatch({
        changes: { from: line.from, to: line.from + current.length, insert },
        selection: { anchor: Math.max(line.from, state.selection.main.head - current.length + insert.length) }
    });
    return true;
}

/**
 * Insert a block on its own line, with a blank line either side.
 *
 * This is the scene break, and it is the button in the set most worth having:
 * every novel needs them, the convention is not obvious, and a writer left to
 * invent one tends to use a row of hyphens or four blank lines — neither of
 * which survives typesetting or means anything to a parser.
 */
function insertBlock(view, text) {
    const { state } = view;
    const line = state.doc.lineAt(state.selection.main.head);

    /*
     * A blank line on BOTH sides, and only where one is not already there.
     *
     * Both halves matter. Without the leading blank, `***` on the line straight
     * after a paragraph is not a scene break at all - every Markdown parser
     * reads it as more of that paragraph, so the break silently disappears from
     * anything that renders the manuscript. Without the "only where needed"
     * test, pressing the button on a line that already has space around it
     * stacks a second blank and the gap grows every time it is used.
     */
    const lead = line.text.trim() ? '\n\n' : '\n';

    const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
    // No next line means the end of the chapter: leave a blank line and a line
    // to write on, because the reason to end a scene is to start the next one.
    const tail = !next ? '\n\n' : (next.text.trim() ? '\n' : '');

    const insert = `${lead}${text}${tail}`;
    view.dispatch({
        changes: { from: line.to, to: line.to, insert },
        // Below the break, on the blank line, ready for the next scene.
        selection: { anchor: line.to + insert.length }
    });
    return true;
}

/**
 * Type a character at the caret, replacing the selection - exactly what the
 * keyboard would do if the keyboard had the key.
 *
 * This is how the em dash gets typed. A laptop has no numeric keypad, so the
 * Alt+0151 that Windows documents cannot be pressed at all, and the em dash is
 * not a decorative flourish in fiction: it is the interruption mark, the one
 * piece of punctuation dialogue leans on hardest. Without a key for it a writer
 * types two hyphens and either lives with it or fixes them all at the end.
 *
 * Deliberately not a toggle. There is no "un-em-dash" - it is a character, and
 * Undo already removes characters.
 */
function insertText(view, text) {
    const range = view.state.selection.main;
    view.dispatch({
        changes: { from: range.from, to: range.to, insert: text },
        // After the character, never around it: this is typing, not wrapping.
        selection: { anchor: range.from + text.length }
    });
    return true;
}

/*
 * ---------- the manuscript-wide search highlight ----------
 *
 * Marks every hit for the current search in whichever chapter is on screen, so
 * that jumping from the results list lands you somewhere you can SEE rather
 * than somewhere you then have to scan for the word.
 *
 * Computed live from the document rather than from the offsets the server
 * returned, which is the decision worth defending. Server offsets would be
 * guaranteed to agree with the results list and cost no regex here — but they
 * describe the file as it was READ, so the moment the writer fixes one of the
 * hits the highlight would keep marking a word that is no longer there, and the
 * count in the panel would disagree with the page in front of them. A highlight
 * that lies about the text under it is worse than none. `searchPattern` below
 * therefore mirrors SearchService.buildPattern exactly; if one changes, both do.
 */

const setHighlightEffect = StateEffect.define();

const highlightState = StateField.define({
    create: () => null,
    update(value, tr) {
        for (const effect of tr.effects) {
            if (effect.is(setHighlightEffect)) return effect.value;
        }
        return value;
    }
});

/**
 * MUST MATCH SearchService.buildPattern. Whole-word is a boundary at both ends
 * via Unicode lookarounds, not \b — \b is defined on [A-Za-z0-9_] and a
 * manuscript is full of invented names with accents.
 */
function searchPattern(query, { caseSensitive = false, wholeWord = false } = {}) {
    const escaped = String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const body = wholeWord
        ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`
        : escaped;
    return new RegExp(body, `gu${caseSensitive ? '' : 'i'}`);
}

const matchMark = Decoration.mark({ class: 'cm-proseMatch' });

/**
 * Only the visible ranges are decorated. A chapter is not a large document, but
 * this is recomputed on every keystroke while a highlight is active, and
 * scanning the whole chapter each time is work nobody sees.
 */
function buildHighlights(view) {
    const builder = new RangeSetBuilder();
    const config = view.state.field(highlightState, false);
    if (!config || !config.query) return builder.finish();

    let pattern;
    try {
        pattern = searchPattern(config.query, config);
    } catch {
        return builder.finish();   // never let a bad pattern break the editor
    }

    for (const { from, to } of view.visibleRanges) {
        const text = view.state.sliceDoc(from, to);
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            builder.add(from + match.index, from + match.index + match[0].length, matchMark);
            if (match[0].length === 0) pattern.lastIndex += 1;
        }
    }
    return builder.finish();
}

const highlightPlugin = ViewPlugin.fromClass(class {
    constructor(view) {
        this.decorations = buildHighlights(view);
    }
    update(update) {
        const retargeted = update.transactions.some(tr =>
            tr.effects.some(effect => effect.is(setHighlightEffect)));
        if (update.docChanged || update.viewportChanged || retargeted) {
            this.decorations = buildHighlights(update.view);
        }
    }
}, { decorations: instance => instance.decorations });

/* ------------------------------------------------------------------ *
   WRITING FLAGS

   Weasel words, hedges, passive voice, nominalizations and the AI tells,
   underlined live as the chapter is written. Everything is local and regex -
   see WritingFlags.js for why it is one alternation per category rather than
   nine hundred patterns.

   Built exactly like the search highlight above, and for the same reason: only
   the VISIBLE ranges are decorated. This recomputes on every change, and a
   phrase that straddles the viewport edge resolves as it scrolls into view -
   the same trade the search highlight already makes.
 * ------------------------------------------------------------------ */

const setFlagsEffect = StateEffect.define();

const flagsState = StateField.define({
    create: () => null,
    update(value, tr) {
        for (const effect of tr.effects) {
            if (effect.is(setFlagsEffect)) return effect.value;
        }
        return value;
    }
});

/*
   One mark per category, made once. Decoration.mark() called inside the build
   loop would allocate a new class object for every hit on every keystroke;
   CodeMirror also compares marks by identity when it diffs decorations, so
   fresh objects would defeat that and repaint spans that never changed.
*/
const FLAG_MARKS = new Map(['weasel', 'fillerAdverbs', 'hedging', 'nominalizations',
    'aiVocabulary', 'aiPhrases', 'aiPatterns', 'passiveVoice']
    .map(id => [id, Decoration.mark({ class: `cm-proseFlag cm-proseFlag--${id}` })]));

const FALLBACK_FLAG_MARK = Decoration.mark({ class: 'cm-proseFlag' });

function buildFlags(view) {
    const builder = new RangeSetBuilder();
    const config = view.state.field(flagsState, false);
    if (!config || !config.compiled || !config.compiled.length) return builder.finish();

    for (const { from, to } of view.visibleRanges) {
        const text = view.state.sliceDoc(from, to);
        let hits;
        try {
            hits = scanFlags(text, config.compiled, { only: config.only });
        } catch {
            return builder.finish();   // never let the flags break the editor
        }
        // scan() returns hits sorted and non-overlapping, which is exactly what
        // RangeSetBuilder requires - it throws on an out-of-order add.
        for (const hit of hits) {
            builder.add(from + hit.from, from + hit.to, FLAG_MARKS.get(hit.category) || FALLBACK_FLAG_MARK);
        }
    }
    return builder.finish();
}

const flagsPlugin = ViewPlugin.fromClass(class {
    constructor(view) {
        this.decorations = buildFlags(view);
    }
    update(update) {
        const retargeted = update.transactions.some(tr =>
            tr.effects.some(effect => effect.is(setFlagsEffect)));
        if (update.docChanged || update.viewportChanged || retargeted) {
            this.decorations = buildFlags(update.view);
        }
    }
}, { decorations: instance => instance.decorations });

/**
 * Run something that moves the caret, and put every scroll position OUTSIDE
 * the editor back where it was.
 *
 * Jumping to a search hit or an overuse finding does two things that scroll
 * ancestors, not just the editor: `scrollIntoView` walks up through every
 * scrollable parent, and focusing the contenteditable makes the browser reveal
 * it by the same route. `#main-content` is `overflow: hidden`, which hides a
 * scrollbar but does NOT stop it being scrolled programmatically — so the card
 * slid up and took the editor's own bar with it, off the top of the window.
 *
 * Starting from scrollDOM's PARENT leaves CodeMirror's own scroller alone, so
 * the line still comes into view inside the editor. Everything above it is
 * pinned.
 *
 * Restored twice: once now, and once on the next frame, because focus can
 * scroll after the call returns.
 */
function keepingOuterScroll(view, run) {
    const saved = [];
    for (let el = view.scrollDOM.parentElement; el; el = el.parentElement) {
        saved.push([el, el.scrollTop, el.scrollLeft]);
    }
    const root = document.scrollingElement || document.documentElement;
    saved.push([root, root.scrollTop, root.scrollLeft]);

    run();

    const restore = () => {
        for (const [el, top, left] of saved) {
            if (el.scrollTop !== top) el.scrollTop = top;
            if (el.scrollLeft !== left) el.scrollLeft = left;
        }
    };
    restore();
    requestAnimationFrame(restore);
}

export function createSurface(host, options = {}) {
    const { onChange, onSave, text = '', placeholder = 'Start writing.' } = options;

    /**
     * True while the editor is replacing the text itself.
     *
     * A textarea fires no `input` event when you assign to `.value`, so the
     * old surface got this for free. CodeMirror does notify on a programmatic
     * dispatch, and without this flag loading a chapter would look exactly
     * like the writer typing it - marking the buffer dirty and scheduling an
     * autosave of a file that was just read off disk.
     */
    let applying = false;

    // Held so a chapter load can rebuild the state from these same extensions,
    // which is the only way to drop the undo history with the old document.
    const extensions = [
        lineNumbers({ formatNumber }),
        history(),
        drawSelection(),

        // Prose wraps. Without this CodeMirror scrolls sideways forever.
        EditorView.lineWrapping,

        markdown({ base: markdownLanguage }),
        syntaxHighlighting(proseHighlight),
        search({ top: true }),
        // The manuscript-wide search highlight. Separate from search() above,
        // which is Ctrl+F within this chapter and keeps its own marks.
        highlightState,
        highlightPlugin,
        // Weasel words, hedges, passive voice and the AI tells, underlined as
        // the writer types. Local regex only - see WritingFlags.js.
        flagsState,
        flagsPlugin,

        // Page rules, with the page number on each. A state field rather than a
        // view plugin because these are BLOCK widgets: they take vertical space,
        // and a view plugin only sees the viewport, so every height above it
        // would be wrong.
        pageBreakField,

        placeholderExt(placeholder),

        // Ctrl/Cmd+S is muscle memory for anyone who writes, and the browser's
        // own Save dialog is never what they meant by it. Bold and italic are
        // the same reflex: a writer reaches for Ctrl+I without thinking, and
        // before this the keystroke did nothing at all.
        keymap.of([
            {
                key: 'Mod-s',
                preventDefault: true,
                run: () => { if (onSave) onSave(); return true; }
            },
            { key: 'Mod-b', preventDefault: true, run: (v) => toggleWrap(v, '**') },
            { key: 'Mod-i', preventDefault: true, run: (v) => toggleWrap(v, '*') },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap
        ]),

        EditorView.updateListener.of((update) => {
            if (!update.docChanged || applying) return;
            if (onChange) onChange();
        }),

        // The browser spellchecker is the free first tier of the three that
        // check this text, and a contenteditable does not enable it the way a
        // textarea did. autocorrect and autocapitalize stay off because they
        // mangle dialect, deliberate fragments and invented names.
        EditorView.contentAttributes.of({
            spellcheck: 'true',
            autocorrect: 'off',
            autocapitalize: 'off',
            lang: 'en-US'
        })
    ];

    const view = new EditorView({
        parent: host,
        state: EditorState.create({ doc: text, extensions })
    });

    /*
     * Re-measure whenever the host changes size.
     *
     * The editor section starts with .hidden, which is `display: none`, and
     * SectionRouter only reveals it later. CodeMirror measures itself when it
     * is constructed, so inside a hidden container it records a viewport of
     * zero and keeps it - the document renders but the scroller believes it
     * has nothing to scroll, which looks exactly like a broken overflow rule.
     *
     * The observer fires on the 0 -> real transition when the section is
     * shown, and again on every window resize, which the editor needs anyway.
     */
    const resize = new ResizeObserver(() => view.requestMeasure());
    resize.observe(host);

    return {
        view,

        /**
         * Wrap the selection in a Markdown marker, or unwrap it if it is
         * already wrapped. See toggleWrap.
         */
        toggleWrap(marker) {
            toggleWrap(view, marker);
            keepingOuterScroll(view, () => view.focus());
        },

        /**
         * How many words the server says are on a page.
         *
         * Comes down with every chapter read, from ManuscriptService, so the
         * rules drawn here and the page count in the header are the same
         * number from the same place rather than two copies of 250 that have
         * to be kept in step by hand.
         */
        setPageWords(words) {
            const value = Number(words);
            if (!value || value <= 0) return;
            view.dispatch({ effects: setPageWordsEffect.of(value) });
        },

        /** Turn the current line into a block, or back to plain. See toggleLinePrefix. */
        toggleLinePrefix(prefix) {
            toggleLinePrefix(view, prefix);
            keepingOuterScroll(view, () => view.focus());
        },

        /** Drop a block of its own on the line below. See insertBlock. */
        insertBlock(text) {
            insertBlock(view, text);
            keepingOuterScroll(view, () => view.focus());
        },

        /** Type a character at the caret, replacing the selection. See insertText. */
        insertText(text) {
            insertText(view, text);
            keepingOuterScroll(view, () => view.focus());
        },

        /**
         * Mark every hit for a manuscript-wide search in this chapter.
         *
         * Deliberately does NOT take focus. It is called when results arrive
         * and again after a jump, and stealing the caret out of the search box
         * on every keystroke would make the box unusable.
         */
        setHighlight(query, opts = {}) {
            view.dispatch({
                effects: setHighlightEffect.of(query ? { query, ...opts } : null)
            });
        },

        /** Take the marks away. The writer is reading again. */
        clearHighlight() {
            view.dispatch({ effects: setHighlightEffect.of(null) });
        },

        /**
         * Turn the writing flags on, off, or down to a few categories.
         *
         * Set once. The plugin re-scans on every document change by itself, so
         * nothing has to call this as the writer types - which is the point of
         * doing it in a view plugin rather than pushing offsets in from the
         * editor. Offsets pushed from outside would need remapping through
         * every edit, and would be wrong for exactly as long as it took to
         * recompute them.
         *
         * @param {Array|null} compiled  output of WritingFlags.compile(), or null to clear
         * @param {Set<string>|null} only  restrict to these category ids
         */
        setWritingFlags(compiled, only = null) {
            view.dispatch({
                effects: setFlagsEffect.of(compiled ? { compiled, only } : null)
            });
        },

        /** Everything currently flagged in this chapter, for a panel or a count. */
        writingFlags() {
            const config = view.state.field(flagsState, false);
            if (!config || !config.compiled) return [];
            return scanFlags(view.state.doc.toString(), config.compiled, { only: config.only });
        },

        /** How many hits are marked in THIS chapter right now. */
        countHighlights() {
            const config = view.state.field(highlightState, false);
            if (!config || !config.query) return 0;
            let pattern;
            try {
                pattern = searchPattern(config.query, config);
            } catch {
                return 0;
            }
            const text = view.state.doc.toString();
            let count = 0;
            let match;
            while ((match = pattern.exec(text)) !== null) {
                count += 1;
                if (match[0].length === 0) pattern.lastIndex += 1;
            }
            return count;
        },

        getValue() {
            return view.state.doc.toString();
        },

        /**
         * Replaces the document.
         *
         * `keepHistory` is true for an edit applied on the writer's behalf - a
         * proofing suggestion, say - which they must be able to take back. It
         * is false when another chapter is loaded, where dropping the history
         * is the only correct outcome: undoing across a file boundary would
         * put one chapter's words into another chapter's file.
         */
        setValue(next, { keepHistory = false } = {}) {
            applying = true;
            try {
                if (keepHistory) {
                    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
                    return;
                }

                /*
                 * setState builds a WHOLE NEW STATE, which means every
                 * StateField goes back to whatever its create() returns. The
                 * writing-flags configuration lives in one of those fields, so
                 * opening a chapter silently threw it away and the underlines
                 * never appeared again - the editor loads every chapter through
                 * here, so in the real app they never appeared at all.
                 *
                 * Carried across explicitly. The alternative is for every
                 * caller of setValue to remember to re-arm the flags, which is
                 * the kind of thing that works until someone adds a second
                 * caller.
                 *
                 * There are TWO of these now — the flags and the words-per-page
                 * behind the page rules — so anything else that lives in a
                 * StateField and is configured from outside has to be added
                 * here too, or it will work until the first chapter is opened.
                 */
                const flags = view.state.field(flagsState, false);
                const pageState = view.state.field(pageBreakField, false);

                view.setState(EditorState.create({ doc: next, extensions }));

                const carried = [];
                if (flags) carried.push(setFlagsEffect.of(flags));
                if (pageState) carried.push(setPageWordsEffect.of(pageState.pageWords));
                if (carried.length) view.dispatch({ effects: carried });
            } finally {
                applying = false;
            }
        },

        /**
         * Replace one span, leaving the rest of the document alone.
         *
         * setValue({ keepHistory }) rewrites the whole document in a single
         * transaction, which works but is a blunt instrument for a one-line
         * edit: it makes Ctrl+Z undo the entire chapter rather than the change
         * that was just applied, and CodeMirror has to remap every position in
         * the document. This touches only what changed, so undo takes back
         * exactly the edit and the caret lands on the new text.
         */
        replaceRange(from, to, insert) {
            applying = true;
            try {
                view.dispatch({
                    changes: { from, to, insert },
                    selection: { anchor: from, head: from + insert.length },
                    scrollIntoView: true
                });
            } finally {
                applying = false;
            }
        },

        getSelection() {
            const range = view.state.selection.main;
            return { from: range.from, to: range.to };
        },

        setSelection(from, to = from) {
            const max = view.state.doc.length;
            const anchor = Math.min(Math.max(0, from), max);
            const head = Math.min(Math.max(0, to), max);
            // scrollIntoView is what brings the line into the editor; the lock
            // stops it dragging the card and the editor's bar up with it.
            keepingOuterScroll(view, () => {
                view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
            });
        },

        get length() {
            return view.state.doc.length;
        },

        focus() {
            // Focusing a contenteditable makes the browser scroll every
            // ancestor to reveal it. Inside the editor that is wanted; outside
            // it slides the card up under the top of the window.
            keepingOuterScroll(view, () => view.focus());
        },

        /** Force a geometry re-read, for callers that know it just appeared. */
        remeasure() {
            view.requestMeasure();
        },

        destroy() {
            resize.disconnect();
            view.destroy();
        }
    };
}
