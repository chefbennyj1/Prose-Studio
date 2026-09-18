// views/dashboard/components/Editor/LiveSpelling.js

/**
 * Red underlines as you type, from Prose Engine's own dictionary.
 *
 * ## Why this exists rather than the browser's
 *
 * In a browser tab the writing surface is spellchecked by Chrome for free, and
 * for a long time that was the first of the four tiers this app checks with.
 * The desktop build does not get it. Electron's spellchecker was switched on,
 * given a language, and reported both "enabled" and "dictionary ready" — and
 * flagged nothing. Proved not to be this editor's fault by right-clicking a
 * misspelling in a plain <textarea> injected into the same page: Chromium
 * reported no misspelled word there either, and no dictionary file was ever
 * downloaded to disk, with or without forcing Hunspell instead of the Windows
 * platform checker.
 *
 * So the underlines come from the same place the Review menu's Spelling scan
 * comes from: SpellService, on the server, with nspell and a real dictionary.
 * That is a better answer than the browser's anyway, and not just a
 * replacement for it:
 *
 *   - it is IDENTICAL in the browser and the desktop app, so there is one
 *     behaviour to explain and one to support
 *   - it knows the writer's characters. A name added to the app's dictionary
 *     stops being underlined here AND stops being reported by the scan;
 *     Chrome's dictionary is a separate thing that would never learn it
 *   - it works offline, and downloads nothing from anybody
 *
 * ## Only what is on screen, only when the typing stops
 *
 * The check runs over the VISIBLE lines, debounced, which is the same trade the
 * search highlight and the writing flags already make. A chapter is thousands
 * of words and this crosses the network: checking all of it on every keystroke
 * would be a request per character for text nobody is looking at.
 *
 * A word that straddles the edge of the viewport resolves as it scrolls into
 * view, exactly as the flags do.
 */

import { Decoration, ViewPlugin, RangeSetBuilder } from '/libs/codemirror/codemirror.js';

/** Long enough that a fast typist is not checked mid-word. */
const QUIET_MS = 600;

const misspelled = Decoration.mark({ class: 'cm-spellError' });

/**
 * The words the server currently says are wrong, for the range it was asked
 * about. Held outside the plugin so a re-render between checks keeps the marks
 * already on screen instead of flickering them off.
 */
function buildMarks(view, found) {
    const builder = new RangeSetBuilder();
    if (!found || !found.size) return builder.finish();

    // Ranges must be added in order or CodeMirror throws.
    const ordered = [...found].sort((a, b) => a.from - b.from);
    for (const { from, to } of ordered) {
        if (from >= 0 && to <= view.state.doc.length && from < to) {
            builder.add(from, to, misspelled);
        }
    }

    return builder.finish();
}

export const liveSpelling = ViewPlugin.fromClass(class {
    constructor(view) {
        this.found = new Set();
        this.decorations = Decoration.none;
        this.timer = null;
        this.controller = null;
        this.schedule(view);
    }

    update(update) {
        if (update.docChanged || update.viewportChanged) {
            /*
             * Move the marks with the text before re-checking.
             *
             * Without this, typing a word at the top of the page leaves every
             * underline below it sitting one character to the left until the
             * next check comes back — the mark stays where the old offsets put
             * it while the words slide out from under it.
             */
            if (update.docChanged) {
                this.decorations = this.decorations.map(update.changes);
                const moved = new Set();
                for (const { from, to } of this.found) {
                    moved.add({
                        from: update.changes.mapPos(from),
                        to: update.changes.mapPos(to)
                    });
                }
                this.found = moved;
            }

            this.schedule(update.view);
        }
    }

    schedule(view) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.check(view), QUIET_MS);
    }

    async check(view) {
        // Abandon a check the writer has already typed past.
        if (this.controller) this.controller.abort();
        this.controller = new AbortController();

        const { from, to } = view.viewport;
        const text = view.state.sliceDoc(from, to);
        if (!text.trim()) {
            this.found = new Set();
            this.decorations = Decoration.none;
            return;
        }

        let data;
        try {
            const res = await fetch('/api/proofing/spell', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text }),
                signal: this.controller.signal
            });
            data = await res.json();
        } catch (err) {
            // Aborted, offline, or the server is restarting. Leave whatever is
            // on screen alone: stale underlines are better than a surface that
            // flickers clean every time a request fails.
            return;
        }

        if (!data || !data.ok) return;

        const found = new Set();
        for (const finding of data.findings || []) {
            for (const occurrence of finding.occurrences || []) {
                const start = from + occurrence.offset;
                found.add({ from: start, to: start + finding.word.length });
            }
        }

        this.found = found;
        this.decorations = buildMarks(view, found);

        // The plugin's decorations are read by the view, which has already
        // finished this update cycle; ask for another.
        view.requestMeasure();
        view.dispatch({});
    }

    destroy() {
        clearTimeout(this.timer);
        if (this.controller) this.controller.abort();
    }
}, {
    decorations: instance => instance.decorations
});
