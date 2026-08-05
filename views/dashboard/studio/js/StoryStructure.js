// views/dashboard/studio/js/StoryStructure.js

/**
 * The two rail sections that make things: Create Story and Create Chapter.
 *
 * They replaced Create Volume / Edit Volume / New Chapter, which drove the
 * comic tree — Series and Volume records in Mongo plus a
 * Library/<Series>/Volumes/volume-N/chapter-N/pageN/ folder scaffold. None of
 * that describes a novel, and none of it touched the story root.
 *
 * Both dispatch `storyTreeChanged` on success so the editor refreshes its
 * pickers without a reload.
 */

const announce = (detail) =>
    document.dispatchEvent(new CustomEvent('storyTreeChanged', { detail }));

function show(el, message, isError) {
    if (!el) return;
    el.textContent = message || '';
    el.hidden = !message;
    el.classList.toggle('text-error', Boolean(isError));
}

async function postJson(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return res.json();
}

/** Fills a <select> with the current stories. Returns how many there were. */
async function fillStorySelect(select) {
    if (!select) return 0;
    try {
        const res = await fetch('/api/manuscript/stories');
        const data = await res.json();

        select.innerHTML = '';
        if (!data.ok || !data.stories?.length) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = data.ok ? 'No stories yet — create one first' : 'No story folder set';
            select.appendChild(opt);
            select.disabled = true;
            return 0;
        }

        select.disabled = false;
        for (const story of data.stories) {
            const opt = document.createElement('option');
            opt.value = story.name;
            opt.textContent = `${story.name} — ${story.chapters} chapter${story.chapters === 1 ? '' : 's'}`;
            select.appendChild(opt);
        }
        return data.stories.length;
    } catch {
        return 0;
    }
}

export async function initCreateStory() {
    const form = document.getElementById('create-story-form');
    if (!form) return;

    const title = document.getElementById('newStoryTitle');
    const button = document.getElementById('createStoryBtn');
    const error = document.getElementById('createStoryError');
    const status = document.getElementById('createStoryStatus');
    const hint = document.getElementById('createStoryRootHint');

    // Say where the folder will land, so nobody has to guess or go to Settings.
    try {
        const res = await fetch('/api/storage/root');
        const data = await res.json();
        hint.textContent = data.configured
            ? `Stories are created in ${data.root}`
            : 'No story folder is set yet. Choose one in File Settings first.';
    } catch { /* hint is a nicety, not a requirement */ }

    form.onsubmit = async (e) => {
        e.preventDefault();
        show(error, '');
        show(status, '');

        const name = title.value.trim();
        if (!name) return show(error, 'Give the story a title first.', true);

        button.disabled = true;
        try {
            const data = await postJson('/api/manuscript/story', { name });
            if (!data.ok) return show(error, data.message, true);

            title.value = '';
            show(status, `Created “${data.story.name}”. Add a chapter to start writing.`);
            announce({ story: data.story.name });
        } catch {
            show(error, 'Could not reach the server.', true);
        } finally {
            button.disabled = false;
        }
    };
}

export async function initCreateChapter() {
    const form = document.getElementById('create-chapter-form');
    if (!form) return;

    const storySelect = document.getElementById('newChapterStory');
    const title = document.getElementById('newChapterTitle');
    const button = document.getElementById('createChapterBtn');
    const error = document.getElementById('createChapterError');
    const status = document.getElementById('createChapterStatus');

    await fillStorySelect(storySelect);

    // A story made in the other section should appear here without a reload.
    document.addEventListener('storyTreeChanged', async (e) => {
        await fillStorySelect(storySelect);
        if (e.detail?.story) storySelect.value = e.detail.story;
    });

    form.onsubmit = async (e) => {
        e.preventDefault();
        show(error, '');
        show(status, '');

        const story = storySelect.value;
        const name = title.value.trim();
        if (!story) return show(error, 'Create a story first — a chapter needs one to live in.', true);
        if (!name) return show(error, 'Give the chapter a title first.', true);

        button.disabled = true;
        try {
            const data = await postJson('/api/manuscript/chapter', { story, name });
            if (!data.ok) return show(error, data.message, true);

            title.value = '';
            show(status, `Created “${data.chapter.name}” in ${story}. Open the Editor to write it.`);
            announce({ story, chapter: data.chapter.name });
        } catch {
            show(error, 'Could not reach the server.', true);
        } finally {
            button.disabled = false;
        }
    };
}
