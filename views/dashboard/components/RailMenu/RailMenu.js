// views/dashboard/components/RailMenu/RailMenu.js

/**
 * The menus in the studio rail: Story, Chapter, Narrator.
 *
 * These replaced the dropdowns that used to sit in the editor's bar. The bar
 * is for writing in; choosing what to write in - and how it should sound -
 * belongs with the rest of the navigation.
 *
 * Story and Chapter put their list straight in the menu: one click on the rail
 * button shows "Create New" and everything you could open. They used to hide
 * the list behind an "Open" row that flew out sideways, and that was broken in
 * a way that made the menus look dead - the row revealed the flyout on
 * mouseenter, and the click that followed found it already open and closed it
 * again. Hovering worked; clicking never did. Removing the middle step removed
 * the conflict along with a level of navigation nobody asked for.
 *
 * The Narrator menu still uses submenus, because its rows are a voice list and
 * a pronunciation form rather than one list of destinations. Those carry no
 * data-list: their contents belong to NarratorMenu.js, they open on CLICK, and
 * they stay open until the menu is dismissed, because you cannot type into a
 * flyout that closes when the pointer wanders off the row that opened it.
 *
 * Lists are fetched when the menu opens, never cached. A story or chapter
 * created in another section is therefore always there the next time you look,
 * with no invalidation to get wrong.
 *
 * Talking to the editor is one-way in each direction, over events:
 *   - this dispatches `openManuscript` when something is chosen
 *   - the editor dispatches `manuscriptOpened` once it has actually opened it,
 *     which is how this knows the current story and can tick it in the list
 * The editor stays the only thing that touches the manuscript.
 */

import { escapeHtml } from '../Editor/EditorRender.js';

let current = { story: null, chapter: null };

/**
 * Whether the editor exists yet.
 *
 * Sections are initialised lazily, when their fragment loads, and the editor is
 * the only thing that listens for `openManuscript`. Until it has been opened
 * once, choosing a story from these menus dispatched an event with no listener:
 * nothing opened, `current.story` was never set by the echo, and the chapter
 * list stayed on "Open a story first" while the writer stared at the story they
 * had just chosen. It worked as soon as they visited the Editor, which is the
 * kind of bug people learn to walk around instead of reporting.
 */
let editorReady = false;

export function initRailMenus() {
    const menus = [...document.querySelectorAll('.rail-menu')];
    menus.forEach(wire);

    /*
     * The transport block keeps the menu OPEN.
     *
     * Every other row in these menus is a choice — pick a voice, start a check —
     * and closing afterwards is right, because there is nothing left to do.
     * Playback is the opposite: skipping forward four paragraphs is four
     * presses, and a menu that shut after the first would cost two clicks for
     * every one of them.
     *
     * That cost is the whole reason the transport was kept OUT of the rail
     * until 2026-08-13. It lives here now, and this line is what makes that
     * decision survivable. If it is ever removed, move the player back out.
     */
    document.querySelectorAll('.rail-menu__transport').forEach((block) => {
        block.addEventListener('click', event => event.stopPropagation());
    });

    // One listener for all of them: clicking anywhere that is not inside an
    // open menu closes it. Handlers inside stopPropagation to opt out.
    document.addEventListener('click', () => menus.forEach(closeMenu));
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') menus.forEach(closeMenu);
    });

    document.addEventListener('manuscriptOpened', (event) => {
        current = {
            story: event.detail?.story || null,
            chapter: event.detail?.chapter || null
        };
    });

    document.addEventListener('editorReady', () => { editorReady = true; });

    // It may already have loaded before these menus were wired, in which case
    // the event above has been and gone. #editorSurface is where the writing
    // surface mounts (see Editor.js), so a CodeMirror inside it means the
    // editor is up.
    if (document.querySelector('#editorSurface .cm-editor')) editorReady = true;
}

/**
 * Runs `andThen` once the editor is there to hear it, opening the Editor
 * section first if it has not been opened yet.
 *
 * Choosing a story or a chapter MEANS "open this", and the place it opens is
 * the editor — so going there is the honest response to the click, not a
 * workaround. The wait matters: the fragment loads asynchronously and
 * dispatching into the gap would be the same silence this fixes.
 */
function withEditor(andThen) {
    if (editorReady) return andThen();

    const go = document.querySelector('.studio-rail__btn[data-target="editor"]');
    if (!go) return andThen();   // no way to get there; better to try than to do nothing

    const once = () => {
        document.removeEventListener('editorReady', once);
        clearTimeout(timer);
        andThen();
    };
    document.addEventListener('editorReady', once);

    // If it never announces itself, go ahead anyway rather than swallowing the
    // click. A late listener is still better than no attempt.
    const timer = setTimeout(once, 4000);

    go.click();
}

function closeMenu(root) {
    root.classList.remove('rail-menu--open');
    root.querySelectorAll('.rail-menu__submenu').forEach(hideFlyout);
}

function hideFlyout(submenu) {
    submenu.classList.remove('is-flyout-open');
    submenu.querySelector('[data-action="open"]')?.setAttribute('aria-expanded', 'false');

    // Cleared so the next open measures fresh: the list may be a different
    // height, and the rail may have moved.
    const flyout = submenu.querySelector('.rail-menu__flyout');
    if (flyout) { flyout.style.top = ''; flyout.style.bottom = ''; }
}

/** Breathing room between a flyout and the edge of the window. */
const EDGE = 8;

/**
 * Keeps a flyout on screen.
 *
 * CSS alone cannot do this. The Narrator menu sits at the bottom of the rail
 * so its flyouts are anchored upward, but the voice list is as tall as the
 * number of installed voices - with the full catalogue it measured 600px and
 * started 265px above the top of the window, which is simply gone. Anchoring
 * downward instead would put the same problem at the bottom for a menu near
 * the foot of the rail.
 *
 * So the flyout is aligned with its row and then pushed back inside the
 * viewport if it does not fit. Written as an offset from the submenu because
 * that is what the flyout is positioned against.
 */
function place(submenu, flyout) {
    const anchor = submenu.getBoundingClientRect();
    const height = flyout.offsetHeight;
    if (!height) return;

    let top = anchor.top;
    if (top + height > window.innerHeight - EDGE) top = window.innerHeight - EDGE - height;
    if (top < EDGE) top = EDGE;

    flyout.style.bottom = 'auto';
    flyout.style.top = `${Math.round(top - anchor.top)}px`;
}

function wire(root) {
    const trigger = root.querySelector('.rail-menu__trigger');
    const menu = root.querySelector('.glass-dropdown-menu');
    if (!trigger || !menu) return;

    const list = menu.querySelector('.rail-menu__list[data-list]');

    trigger.addEventListener('click', (event) => {
        // Not the document handler's business, and the rail's own navigation
        // handler must not treat this as a section button either.
        event.stopPropagation();
        event.preventDefault();

        const opening = !root.classList.contains('rail-menu--open');
        document.querySelectorAll('.rail-menu').forEach(closeMenu);
        if (!opening) return;

        root.classList.add('rail-menu--open');
        // Fetched on every open, so a story created elsewhere is always here.
        if (list) populate(list.dataset.list, list);
    });

    // Create New navigates by data-target through the rail handler; all this
    // has to do is get the menu out of the way.
    menu.querySelectorAll('[data-action="create"]').forEach((item) => {
        item.addEventListener('click', () => closeMenu(root));
    });

    if (list) {
        list.addEventListener('click', (event) => {
            const entry = event.target.closest('.rail-menu__entry');
            if (!entry) return;

            event.stopPropagation();
            choose(list.dataset.list, entry.dataset.name);
            closeMenu(root);
        });
    }

    root.querySelectorAll('.rail-menu__submenu').forEach(submenu => wireSubmenu(root, menu, submenu));
}

/**
 * The Narrator menu's rows. Click to open, click again to close, and no
 * mouseenter: a hover-reveal plus a click-toggle is what made the old Story
 * menu impossible to open with the mouse.
 */
function wireSubmenu(root, menu, submenu) {
    const parent = submenu.querySelector('[data-action="open"]');
    const flyout = submenu.querySelector('.rail-menu__flyout');
    if (!parent || !flyout) return;

    parent.addEventListener('click', (event) => {
        // Without this the kit's outside-click handler closes the whole menu.
        event.stopPropagation();

        if (submenu.classList.contains('is-flyout-open')) {
            hideFlyout(submenu);
            return;
        }

        // Only one flyout at a time, or two would overlap in the same place.
        root.querySelectorAll('.rail-menu__submenu').forEach(hideFlyout);
        submenu.classList.add('is-flyout-open');
        parent.setAttribute('aria-expanded', 'true');
        submenu.dispatchEvent(new CustomEvent('flyoutOpened', { bubbles: true }));

        // Placed after the event, so a flyout that fills itself on open is
        // measured at the height it actually ends up. Again on the next frame
        // for the ones that fetch.
        place(submenu, flyout);
        requestAnimationFrame(() => place(submenu, flyout));
    });

    // These flyouts hold inputs and buttons. Clicks inside must not reach the
    // document handler, which would close the menu out from under whatever was
    // just pressed.
    flyout.addEventListener('click', event => event.stopPropagation());
}

async function populate(kind, flyout) {
    if (kind === 'chapter' && !current.story) {
        flyout.innerHTML = note('Open a story first.');
        return;
    }

    flyout.innerHTML = note('Loading...');

    const url = kind === 'story'
        ? '/api/manuscript/stories'
        : `/api/manuscript/chapters?story=${encodeURIComponent(current.story)}`;

    let data;
    try {
        data = await (await fetch(url)).json();
    } catch {
        flyout.innerHTML = note('Could not reach the server.');
        return;
    }

    if (!data.ok) {
        flyout.innerHTML = note(data.code === 'NO_STORY_ROOT'
            ? 'No story folder is set. Choose one in File Settings.'
            : data.message || 'Could not read that list.');
        return;
    }

    const items = kind === 'story' ? data.stories : data.chapters;
    if (!items.length) {
        flyout.innerHTML = note(kind === 'story'
            ? 'No stories yet. Create one.'
            : 'No chapters in this story yet.');
        return;
    }

    flyout.innerHTML = items.map((item) => entry(kind, item)).join('');
}

function entry(kind, item) {
    const open = kind === 'story' ? current.story : current.chapter;
    const active = item.name === open ? ' is-active' : '';

    const count = kind === 'story'
        ? `${item.chapters} chapter${item.chapters === 1 ? '' : 's'}`
        : `${item.pages} page${item.pages === 1 ? '' : 's'}`;

    return `<button type="button" class="rail-menu__item rail-menu__entry${active}"
                role="menuitem" data-name="${escapeHtml(item.name)}">
                <span class="rail-menu__name">${escapeHtml(item.name)}</span>
                <span class="rail-menu__count">${escapeHtml(count)}</span>
            </button>`;
}

function note(message) {
    return `<p class="rail-menu__note">${escapeHtml(message)}</p>`;
}

/**
 * Choosing a story clears the chapter: the editor picks the first one, the
 * same as it does on a cold start. Naming a chapter that belongs to a
 * different story would open the wrong file.
 */
function choose(kind, name) {
    const detail = kind === 'story'
        ? { story: name, chapter: null }
        : { story: current.story, chapter: name };

    /*
     * Remember the story straight away rather than waiting for the editor's
     * echo. The echo still arrives and still corrects this, but the chapter
     * list is usually opened within a second of choosing the story, and
     * `manuscriptOpened` does not come back until a chapter has been read off
     * disk. Without this, the flyout had nothing to fetch with and said "Open a
     * story first" about the story that was already opening.
     */
    if (kind === 'story') current = { story: name, chapter: null };

    withEditor(() => document.dispatchEvent(new CustomEvent('openManuscript', { detail })));
}
