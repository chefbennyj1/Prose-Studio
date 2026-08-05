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
    search, searchKeymap
} from '/libs/codemirror/codemirror.js';

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
        placeholderExt(placeholder),

        // Ctrl/Cmd+S is muscle memory for anyone who writes, and the browser's
        // own Save dialog is never what they meant by it.
        keymap.of([
            {
                key: 'Mod-s',
                preventDefault: true,
                run: () => { if (onSave) onSave(); return true; }
            },
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
                view.setState(EditorState.create({ doc: next, extensions }));
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
            view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
        },

        get length() {
            return view.state.doc.length;
        },

        focus() {
            view.focus();
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
