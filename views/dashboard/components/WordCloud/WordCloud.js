// views/dashboard/components/WordCloud/WordCloud.js

/**
 * The word cloud.
 *
 * Whole novel by default, function words stripped, sized by how often the
 * writer actually reaches for a word. See WordCloudService for why a raw
 * frequency count would have shown "the, and, she" and told nobody anything.
 *
 * NO LIBRARY. d3-cloud is the usual answer and it is ~15KB plus a build step,
 * for an algorithm that is a spiral and a rectangle overlap test. Everything
 * else a writer touches here - spelling, mechanics, the thesaurus, Piper - runs
 * without reaching for the network, and a cloud that cannot draw itself offline
 * would be the odd one out.
 */

/** Breathing room around every word, in px. Below about 6 they read as joined. */
const GAP = 8;

let els = {};
let doc = { story: null, chapter: null };
let data = null;
let mode = 'story';

export function initWordCloud(container) {
    els = {
        root: container.querySelector('.word-cloud'),
        canvas: container.querySelector('#wordCloudCanvas'),
        status: container.querySelector('#wordCloudStatus'),
        scope: container.querySelector('#wordCloudScope'),
        chapter: container.querySelector('#wordCloudChapter'),
        detail: container.querySelector('#wordCloudDetail')
    };
    if (!els.canvas) return;

    els.scope?.addEventListener('change', () => {
        mode = els.scope.value;
        els.chapter.classList.toggle('hidden', mode !== 'chapter');
        load();
    });
    els.chapter?.addEventListener('change', load);

    // Re-laying out on every resize pixel would thrash; the cloud only needs to
    // be right once the writer has stopped dragging.
    let resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { if (data) draw(data); }, 200);
    });

    document.addEventListener('manuscriptOpened', (event) => {
        const next = event.detail?.story || null;
        const changed = next !== doc.story;
        doc = { story: next, chapter: event.detail?.chapter || null };
        if (changed) data = null;
        if (isVisible()) load();
    });

    if (doc.story) load();
}

function isVisible() {
    return els.root && !els.root.classList.contains('hidden');
}

/** Called by the router when the section becomes visible. */
export function refreshWordCloud() {
    if (!data) load();
}

async function load() {
    if (!els.canvas) return;
    if (!doc.story) {
        say('Open a story to see what it is made of.');
        return;
    }

    say('Reading the whole manuscript...');
    try {
        const query = new URLSearchParams({ story: doc.story });
        if (mode === 'chapter' && els.chapter.value) query.set('chapter', els.chapter.value);

        const response = await (await fetch(`/api/proofing/word-cloud?${query}`)).json();
        if (!response.ok) throw new Error(response.message || 'Could not read the story.');

        data = response;
        fillChapters(response.chapters);
        draw(response);
    } catch (err) {
        say(err.message);
    }
}

function fillChapters(chapters) {
    if (!els.chapter || !chapters) return;
    const chosen = els.chapter.value;
    els.chapter.innerHTML = chapters
        .map(name => `<option value="${escapeAttr(name)}">${escapeHtml(name)}</option>`).join('');
    if (chapters.includes(chosen)) els.chapter.value = chosen;
    else if (chapters.includes(doc.chapter)) els.chapter.value = doc.chapter;
}

/* ---------- layout ---------- */

/**
 * Archimedean spiral placement.
 *
 * Biggest word first at the centre, then each next word walks outward along a
 * spiral until it finds a spot touching nothing already placed. That ordering
 * matters: placing small words first fills the middle with noise and pushes the
 * words that carry the meaning out to the edges.
 *
 * Collisions are rectangle overlap, not per-glyph. Real clouds nest letters
 * into each other's gaps, which needs a pixel mask and is a great deal of work
 * for a denser picture of the same information.
 */
function draw(cloud) {
    /*
     * The height comes from the BOX, not from the width.
     *
     * It was Math.max(420, width * 0.58), which on a wide window produced an
     * SVG taller than the panel holding it - so the bottom row of words was
     * cut off by the scroll edge and the cloud looked broken rather than full.
     * A cloud has to fit the space it is given; there is no natural aspect
     * ratio for one.
     */
    const width = els.canvas.clientWidth || 800;
    const height = Math.max(320, els.canvas.clientHeight || 420);

    const measure = document.createElement('canvas').getContext('2d');
    const placed = [];

    // The index into cloud.words travels with the word, because placement drops
    // any word it cannot fit - so a placed word's position in `placed` is not
    // its position in the data, and hover would describe the wrong one.
    cloud.words.forEach((entry, index) => { entry.__index = index; });

    for (const entry of cloud.words) {
        const size = entry.size;
        measure.font = `${weightFor(entry)} ${size}px Georgia, "Iowan Old Style", serif`;
        const metrics = measure.measureText(entry.word);

        /*
         * The real inked bounds, not an estimate.
         *
         * `size * 0.82` was a guess at cap height and it was too small: a word
         * with an ascender and a descender - "bleeding", "awning" - occupies
         * well over one em, so neighbours were placed into space the glyphs
         * actually use and the cloud came out with words touching. The ascent
         * and descent metrics are exact, and the fallback covers the engines
         * that do not report them.
         */
        const ascent = metrics.actualBoundingBoxAscent || size * 0.72;
        const descent = metrics.actualBoundingBoxDescent || size * 0.24;

        // GAP is breathing room. Without it words merely fail to overlap,
        // which still reads as a collision at these sizes.
        const w = metrics.width + GAP;
        const h = ascent + descent + GAP;

        const spot = findSpot(w, h, width, height, placed);
        if (!spot) continue;   // no room left; the tail is the least important
        placed.push({ ...spot, w, h, ascent, entry });
    }

    els.canvas.innerHTML = render(placed, width, height);
    els.canvas.querySelectorAll('[data-word]').forEach((node) => {
        node.addEventListener('mouseenter', () => describe(cloud.words[Number(node.dataset.word)]));
        node.addEventListener('click', () => describe(cloud.words[Number(node.dataset.word)]));
    });

    const scope = cloud.mode === 'chapter' ? `“${cloud.chapter}” against the rest of the book` : 'the whole story';
    say(`${placed.length} words from ${cloud.stats.words.toLocaleString()} across `
        + `${cloud.stats.chapters} chapter${cloud.stats.chapters === 1 ? '' : 's'} — ${scope}.`);
}

function findSpot(w, h, width, height, placed) {
    const cx = width / 2;
    const cy = height / 2;

    // step 0.35rad keeps successive attempts adjacent rather than jumping in
    // arcs and leaving obvious holes; 0.55 spreads the spiral about a word's
    // height per turn.
    for (let t = 0; t < 2200; t++) {
        const angle = t * 0.35;
        const radius = 0.55 * angle;
        const x = cx + radius * Math.cos(angle) - w / 2;
        const y = cy + radius * Math.sin(angle) * 0.62;   // squashed: pages are wider than tall

        if (x < 0 || y < 0 || x + w > width || y + h > height) continue;
        if (placed.some(p => x < p.x + p.w && x + w > p.x && y < p.y + p.h && y + h > p.y)) continue;
        return { x, y };
    }
    return null;
}

function render(placed, width, height) {
    const words = placed.map((p) => {
        const cloudIndex = p.entry.__index;
        // SVG's y is the BASELINE, so the box's top plus its ascent puts the
        // glyphs exactly where the layout reserved room for them. Half the gap
        // keeps the padding even above and below.
        return `<text x="${(p.x + p.w / 2).toFixed(1)}" y="${(p.y + p.ascent + GAP / 2).toFixed(1)}"
            class="word-cloud__word${p.entry.isName ? ' word-cloud__word--name' : ''}"
            style="font-size:${p.entry.size}px;font-weight:${weightFor(p.entry)}"
            data-word="${cloudIndex}" text-anchor="middle">${escapeHtml(p.entry.word)}</text>`;
    }).join('');

    return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}"
        role="img" aria-label="Word cloud">${words}</svg>`;
}

/**
 * Heavier for the words used more. Size already carries the ranking, but at
 * small sizes the difference between 14px and 12px is nearly invisible, and
 * weight keeps the ordering readable down the tail.
 */
function weightFor(entry) {
    return entry.size >= 34 ? 700 : entry.size >= 22 ? 600 : 400;
}

/**
 * What one word actually costs, on hover.
 *
 * The cloud shows proportion; this is where the number lives. Dialogue is
 * called out separately because a word a character says is characterisation
 * and a word the narrator reaches for is habit.
 */
function describe(entry) {
    if (!els.detail || !entry) return;
    const narration = entry.count - entry.dialogue;
    const parts = [`<strong>${escapeHtml(entry.word)}</strong> — ${entry.count} use${entry.count === 1 ? '' : 's'}`];

    if (entry.dialogue) {
        parts.push(`${narration} in narration, ${entry.dialogue} in dialogue`);
    }
    if (entry.chapters) {
        parts.push(`in ${entry.chapters} chapter${entry.chapters === 1 ? '' : 's'}`);
    }
    if (entry.isName) parts.push('a name from your pronunciation list');

    els.detail.innerHTML = parts.join(' &nbsp;·&nbsp; ');
}

function say(message) {
    if (els.status) els.status.textContent = message;
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const escapeAttr = escapeHtml;
