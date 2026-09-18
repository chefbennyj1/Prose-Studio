// build/codemirror-entry.js

/**
 * Bundle entry for the writing surface.
 *
 * CodeMirror 6 ships as a dozen small ESM packages that import each other by
 * bare specifier, so a browser cannot load it out of node_modules the way
 * kokoro-js can. This file names everything the editor actually uses and
 * esbuild flattens it into one module at libs/codemirror/codemirror.js.
 *
 *     npm run build:editor
 *
 * Keep this list tight. Every export here is bytes the writer downloads before
 * they can type, and CodeMirror's basicSetup drags in autocompletion, linting
 * and code folding that a manuscript has no use for.
 */

// Decoration, ViewPlugin and RangeSetBuilder are here for the manuscript-wide
// search highlight. CodeMirror's own search already highlights, but driving it
// would style prose the way it styles code - a solid block per hit - and a
// manuscript page wearing forty of those is measurably harder to READ, which is
// what that surface is for. Owning the decoration is what buys the softer mark.
export { EditorView, keymap, lineNumbers, placeholder, drawSelection, highlightActiveLine, Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
export { EditorState, Compartment, StateField, StateEffect, RangeSetBuilder } from '@codemirror/state';
export { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
// No @codemirror/language-data. It exists to syntax-highlight fenced code
// blocks by language and costs well over a megabyte to do it. A manuscript
// does not contain Rust.
export { markdown, markdownLanguage } from '@codemirror/lang-markdown';
export { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
export { tags } from '@lezer/highlight';
export { search, searchKeymap, openSearchPanel } from '@codemirror/search';
