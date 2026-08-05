// views/dashboard/components/RailMenu/RailMenu.js

/**
 * The Story and Chapter menus in the studio rail.
 *
 * These replaced the two dropdowns that used to sit in the editor's bar. The
 * bar is for writing in; choosing what to write in belongs with the rest of
 * the navigation.
 *
 * Each menu offers "Create New" and "Open". Create New is a plain
 * .glass-dropdown-item carrying a data-target, so the rail's existing
 * navigation handles it and the kit's own dropdown closes the menu on click.
 * Open is deliberately NOT one: GlassDropdown binds every .glass-dropdown-item
 * to close(), which would shut the menu before its flyout could be seen.
 *
 * Lists are fetched when the flyout opens, never cached. A story or chapter
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

export function initRailMenus() {
    const menus = [...document.querySelectorAll('.rail-menu')];
    menus.forEach(wire);

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
}

function closeMenu(root) {
    root.classList.remove('is-open', 'is-flyout-open');
    const parent = root.querySelector('[data-action="open"]');
    if (parent) parent.setAttribute('aria-expanded', 'false');
}

function wire(root) {
    const kind = root.dataset.menu;
    const trigger = root.querySelector('.rail-menu__trigger');
    const parent = root.querySelector('[data-action="open"]');
    const flyout = root.querySelector('.rail-menu__flyout');
    const menu = root.querySelector('.glass-dropdown-menu');
    if (!kind || !trigger || !parent || !flyout || !menu) return;

    trigger.addEventListener('click', (event) => {
        // Not the document handler's business, and the rail's own navigation
        // handler must not treat this as a section button either.
        event.stopPropagation();
        event.preventDefault();

        const opening = !root.classList.contains('is-open');
        document.querySelectorAll('.rail-menu').forEach(closeMenu);
        if (opening) root.classList.add('is-open');
    });

    // Create New navigates by data-target through the rail handler; all this
    // has to do is get the menu out of the way.
    menu.querySelectorAll('[data-action="create"]').forEach((item) => {
        item.addEventListener('click', () => closeMenu(root));
    });

    const reveal = async () => {
        if (root.classList.contains('is-flyout-open')) return;
        root.classList.add('is-flyout-open');
        parent.setAttribute('aria-expanded', 'true');
        await populate(kind, flyout);
    };

    const hide = () => {
        root.classList.remove('is-flyout-open');
        parent.setAttribute('aria-expanded', 'false');
    };

    parent.addEventListener('click', (event) => {
        // Without this the kit's outside-click handler closes the whole menu.
        event.stopPropagation();
        if (root.classList.contains('is-flyout-open')) {
            hide();
            return;
        }
        reveal();
    });

    parent.addEventListener('mouseenter', reveal);
    menu.addEventListener('mouseleave', hide);

    flyout.addEventListener('click', (event) => {
        const entry = event.target.closest('.rail-menu__entry');
        if (!entry) return;

        event.stopPropagation();
        choose(kind, entry.dataset.name);

        hide();
        // These entries did not exist when GlassDropdown bound its items, so
        // closing the parent menu is this component's job.
        root.classList.remove('is-open');
    });
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

    document.dispatchEvent(new CustomEvent('openManuscript', { detail }));
}
