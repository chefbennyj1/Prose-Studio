// views/dashboard/components/RailMenu/ReviewMenu.js

/**
 * The Review menu in the studio rail.
 *
 * Everything that used to be the editor's right-hand panel except the results:
 * the four checks, the critic's lens and engine, and which mechanics rules are
 * allowed to speak. The panel is now output only, and this is where you say
 * what you want looked at.
 *
 * Talking to the editor is one-way in each direction, over events, the same
 * contract RailMenu already uses for the manuscript:
 *   - this dispatches `runReview` with { task, lens, engine, mechanics }
 *   - the editor dispatches `reviewFinished` with { total, error } once a scan
 *     lands, which is how the rail badge knows there is something to read
 * The editor stays the only thing that touches the manuscript, and this stays
 * the only thing that decides what a check is asked to do.
 *
 * The lens, the engine and the disabled rule list are remembered. All three are
 * decisions a writer makes about how they work rather than about this chapter,
 * and re-picking "Line edit" every session is the kind of friction that ends
 * with the feature going unused.
 */

import { escapeHtml } from '../Editor/EditorRender.js';

const STORE_KEY = 'prose_engine_review';

let critic = null;      // { lenses, defaultLens, ai: { ok, reason } }
let ruleset = null;     // { groups, rules, defaults }
let els = {};

let overuse = null;     // { groups, words }

// `engine` used to live here too, when a local Gemma and Gemini both answered.
let choice = {
    lens: null,
    disabled: [],
    // Word families the overuse scan skips, and whether to ask Gemini to judge
    // what it counted. Judging is off by default and stays that way until the
    // writer asks: counting is free and local, and a check that quietly starts
    // sending the manuscript off the machine because it was convenient is
    // exactly the thing the opt-in exists to prevent.
    overuseOff: [],
    judge: false
};

export function initReviewMenu() {
    els = {
        badge: document.getElementById('reviewBadge'),
        lensValue: document.getElementById('reviewLensValue'),
        lensFlyout: document.getElementById('reviewLensFlyout'),
        rulesValue: document.getElementById('reviewRulesValue'),
        rulesFlyout: document.getElementById('reviewRulesFlyout'),
        overuseValue: document.getElementById('reviewOveruseValue'),
        overuseFlyout: document.getElementById('reviewOveruseFlyout'),
        flagsValue: document.getElementById('reviewFlagsValue'),
        flagsFlyout: document.getElementById('reviewFlagsFlyout')
    };
    if (!els.lensFlyout) return;

    restore();

    document.querySelectorAll('[data-review]').forEach((button) => {
        // No stopPropagation: the click should reach the document handler that
        // closes the menu. Starting a check is the last thing you do here.
        button.addEventListener('click', () => start(button.dataset.review));
    });

    els.lensFlyout.addEventListener('click', onLensClick);
    els.rulesFlyout.addEventListener('click', onRuleClick);
    els.overuseFlyout?.addEventListener('click', onOveruseClick);
    els.flagsFlyout?.addEventListener('click', onFlagsClick);

    submenu('lens')?.addEventListener('flyoutOpened', drawLensList);
    submenu('rules')?.addEventListener('flyoutOpened', drawRuleList);
    submenu('overuse')?.addEventListener('flyoutOpened', drawOveruseList);
    submenu('flags')?.addEventListener('flyoutOpened', drawFlagsList);

    // Switching the AI on in Settings should put its rows in the menu without
    // a reload; that page dispatches this once the key is saved.
    document.addEventListener('aiSettingsChanged', loadCritic);

    document.addEventListener('reviewFinished', (event) => drawBadge(event.detail));


    loadCritic();
    loadRules();
    loadOveruse();
    // No fetch behind this one - the families are known here, so the summary
    // is correct before anything loads.
    drawFlagsValue();
}

function submenu(name) {
    return document.querySelector(`[data-review-menu="${name}"]`);
}

/* ---------- what the editor is told ---------- */

/**
 * Start a check, from wherever the writer happens to be.
 *
 * The rail is on screen in every section but the editor is injected on
 * navigation, so pressing "Grammar & mechanics" from the Plot Lab would
 * otherwise dispatch into nothing and look broken. Navigating first and
 * waiting for the editor to say it is listening costs one click the writer was
 * going to make anyway.
 */
function start(task) {
    const run = () => document.dispatchEvent(new CustomEvent('runReview', {
        detail: {
            task,
            lens: choice.lens,
            mechanics: getMechanicsOptions(),
            overuse: getOveruseOptions()
        }
    }));

    // Asked of the DOM rather than remembered in a flag. The editor's listener
    // lives on `document` and outlives the section, so "it has loaded once" is
    // not the same question as "its panel is on screen right now" — and it is
    // the second one that decides whether the results have anywhere to go.
    if (document.getElementById('editorOutput')) {
        run();
        return;
    }

    document.addEventListener('editorReady', run, { once: true });

    // The rail's own editor button, rather than a second navigation path: it
    // already knows how to switch sections and how to mark itself active.
    document.querySelector('.studio-rail__btn[data-target="editor"]')?.click();
}

/** The scan options, in the shape MechanicsService.scan expects. */
export function getMechanicsOptions() {
    return { disabled: [...choice.disabled] };
}

/** The scan options, in the shape OveruseService.scan expects, plus `judge`. */
export function getOveruseOptions() {
    return { disabled: [...choice.overuseOff], judge: !!choice.judge };
}

/* ---------- persistence ---------- */

function restore() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
        choice.lens = saved.lens || null;
        choice.disabled = Array.isArray(saved.disabled) ? saved.disabled : [];
        choice.overuseOff = Array.isArray(saved.overuseOff) ? saved.overuseOff : [];
        choice.judge = !!saved.judge;
    } catch {
        // A corrupt entry is not worth a broken menu; the defaults are fine.
    }
}

function remember() {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(choice));
    } catch {
        // Private browsing, quota, whatever. The menu still works this session.
    }
}

/* ---------- critic options ---------- */

async function loadCritic() {
    try {
        const data = await (await fetch('/api/critic/options')).json();
        if (!data.ok) return;
        critic = data;

        if (!choice.lens || !critic.lenses.some(l => l.id === choice.lens)) {
            choice.lens = critic.defaultLens;
        }

        drawAiRows();
        drawCriticValues();
    } catch (err) {
        console.error('[ReviewMenu] Could not load critic options', err);
        drawAiRows();
    }
}

/**
 * Show or hide the rows that need the AI.
 *
 * The AI is opt-in, so until it is switched on in Settings with a key these
 * are not in the menu at all. Showing them greyed out would be worse: it makes
 * the editor look crippled, when in fact everything above them - spelling, the
 * whole mechanics scanner - works and always has.
 */
function drawAiRows() {
    // Hidden ONLY when the server has positively said the AI is off. Anything
    // else - the request failed, or the response has no `ai` field because the
    // server is still running older code - shows them.
    //
    // The first version hid on "not positively on", which is a silent failure
    // in the one place it must not be: half the Review menu disappears, with
    // nothing to say why and nothing to click to find out. Fail open and let
    // the feature report its own error, which is a sentence the writer can act
    // on rather than an absence they have to notice.
    const off = critic?.ai && critic.ai.ok === false;

    document.querySelectorAll('[data-needs-ai]').forEach((row) => {
        row.classList.toggle('hidden', !!off);
        if (off && critic.ai.reason) row.title = critic.ai.reason;
    });
}

function drawCriticValues() {
    if (!critic || !els.lensValue) return;
    const lens = critic.lenses.find(l => l.id === choice.lens);
    els.lensValue.textContent = lens ? lens.label : '';
}

function drawLensList() {
    if (!critic) {
        els.lensFlyout.innerHTML = note('Loading...');
        return;
    }
    // The description is the row's tooltip, not a second column. Beside the
    // name it did not fit: .rail-menu__count does not shrink, so a blurb that
    // long held its width and cut the name it was describing down to an
    // ellipsis. The label now says which pass this is; the tooltip says what it
    // looks for.
    els.lensFlyout.innerHTML = critic.lenses.map(lens => `
        <button type="button" class="rail-menu__item rail-menu__entry${lens.id === choice.lens ? ' is-active' : ''}"
            role="menuitemradio" aria-checked="${lens.id === choice.lens}" data-id="${escapeHtml(lens.id)}"
            title="${escapeHtml(lens.blurb)}">
            <span class="rail-menu__name">${escapeHtml(lens.label)}</span>
        </button>`).join('');
}

function onLensClick(event) {
    const entry = event.target.closest('.rail-menu__entry');
    if (!entry) return;
    choice.lens = entry.dataset.id;
    remember();
    drawCriticValues();
    drawLensList();
}

/* ---------- mechanics rules ---------- */

async function loadRules() {
    try {
        const data = await (await fetch('/api/proofing/mechanics/rules')).json();
        if (!data.ok) return;
        ruleset = data;
        drawRulesValue();
    } catch (err) {
        console.error('[ReviewMenu] Could not load mechanics rules', err);
    }
}

function drawRulesValue() {
    if (!els.rulesValue || !ruleset) return;
    const off = choice.disabled.length;
    els.rulesValue.textContent = off ? `${ruleset.rules.length - off} of ${ruleset.rules.length}` : 'all on';
}

function drawRuleList() {
    if (!ruleset) {
        els.rulesFlyout.innerHTML = note('Loading...');
        return;
    }

    const html = ruleset.groups.map((group) => {
        const rules = ruleset.rules.filter(rule => rule.group === group.id);
        if (!rules.length) return '';

        const rows = rules.map(rule => `
            <button type="button" class="rail-menu__item rail-menu__toggle" role="menuitemcheckbox"
                aria-checked="${!choice.disabled.includes(rule.id)}"
                data-rule="${escapeHtml(rule.id)}" title="${escapeHtml(rule.blurb)}">
                <span class="rail-menu__label">${escapeHtml(rule.label)}</span>
                <span class="rail-menu__severity rail-menu__severity--${escapeHtml(rule.severity)}"
                    aria-hidden="true">${rule.severity === 'error' ? 'error' : 'style'}</span>
                <span class="rail-menu__switch" aria-hidden="true"></span>
            </button>`).join('');

        return `<div class="rail-menu__group-label">${escapeHtml(group.label)}</div>${rows}`;
    }).join('');

    els.rulesFlyout.innerHTML = html || note('No rules.');
}

function onRuleClick(event) {
    const toggle = event.target.closest('[data-rule]');
    if (!toggle) return;

    const id = toggle.dataset.rule;
    const off = choice.disabled.includes(id);
    choice.disabled = off
        ? choice.disabled.filter(entry => entry !== id)
        : [...choice.disabled, id];

    toggle.setAttribute('aria-checked', String(off));
    remember();
    drawRulesValue();
}

/* ---------- overused words ---------- */

async function loadOveruse() {
    if (!els.overuseFlyout) return;
    try {
        const data = await (await fetch('/api/proofing/overuse/words')).json();
        if (!data.ok) return;
        overuse = data;
        drawOveruseValue();
    } catch (err) {
        console.error('[ReviewMenu] Could not load overuse words', err);
    }
}

function drawOveruseValue() {
    if (!els.overuseValue || !overuse) return;
    const on = overuse.groups.length - choice.overuseOff.length;
    els.overuseValue.textContent = choice.overuseOff.length
        ? `${on} of ${overuse.groups.length}`
        : 'all on';
}

/**
 * The word families, and the one row here that sends anything anywhere.
 *
 * The AI row is last and separated, because everything above it is local. It
 * is also the only control in this menu that changes where the manuscript
 * goes rather than what is counted, and it says so on its face.
 */
function drawOveruseList() {
    if (!overuse) {
        els.overuseFlyout.innerHTML = note('Loading...');
        return;
    }

    const groups = overuse.groups.map((group) => {
        const words = overuse.words.filter(word => word.group === group.id);
        const off = choice.overuseOff.includes(group.id);
        return `
            <button type="button" class="rail-menu__item rail-menu__toggle" role="menuitemcheckbox"
                aria-checked="${!off}" data-overuse-group="${escapeHtml(group.id)}"
                title="${escapeHtml(words.slice(0, 8).map(w => w.word).join(', '))}">
                <span class="rail-menu__label">${escapeHtml(group.label)}</span>
                <span class="rail-menu__count">${words.length}</span>
                <span class="rail-menu__switch" aria-hidden="true"></span>
            </button>`;
    }).join('');

    // Hidden with the AI off, for the same reason Critique is: offering it and
    // then failing is worse than not offering it, and the counting above works
    // regardless.
    const judge = `
        <div class="rail-menu__divider" role="separator"></div>
        <button type="button" class="rail-menu__item rail-menu__toggle${aiOff() ? ' hidden' : ''}"
            role="menuitemcheckbox" aria-checked="${!!choice.judge}" data-overuse-judge
            data-needs-ai title="Sends the counts and a few sample sentences to Gemini - not the manuscript.">
            <!--
                "Tics" was the internal verdict value wearing a label. It also
                pointed at the wrong thing: beside a manuscript full of
                characters, a "tic" reads as something a CHARACTER does, when
                what this judges is the author reaching for a word by reflex.
                Ben read it that way, and he wrote the app.

                What a new writer needs to know is what the AI adds to a list of
                counts they can already see: an opinion on which of them are
                worth their time.
            -->
            <span class="rail-menu__label">Ask Gemini which ones are worth fixing</span>
            <span class="rail-menu__switch" aria-hidden="true"></span>
        </button>`;

    els.overuseFlyout.innerHTML = groups + judge;
}

function aiOff() {
    return !!(critic?.ai && critic.ai.ok === false);
}

function onOveruseClick(event) {
    const judge = event.target.closest('[data-overuse-judge]');
    if (judge) {
        choice.judge = !choice.judge;
        judge.setAttribute('aria-checked', String(choice.judge));
        remember();
        return;
    }

    const toggle = event.target.closest('[data-overuse-group]');
    if (!toggle) return;

    const id = toggle.dataset.overuseGroup;
    const off = choice.overuseOff.includes(id);
    choice.overuseOff = off
        ? choice.overuseOff.filter(entry => entry !== id)
        : [...choice.overuseOff, id];

    toggle.setAttribute('aria-checked', String(off));
    remember();
    drawOveruseValue();
}

/* ---------- writing flags ---------- */

/*
   The families, in the order they appear in the flyout, with the defaults that
   Editor.js also holds. Named here rather than fetched from the JSON because
   the menu has to draw before - and regardless of whether - that 85KB file
   loads: a writer looking for the off switch during a slow load must still
   find it.

   Kept deliberately short. `blurb` is what the family costs you, not what it
   is; the label already says what it is.
*/
const FLAG_FAMILIES = [
    { id: 'weasel', label: 'Weasel words', on: true, blurb: 'very, just, really, clearly' },
    { id: 'hedging', label: 'Hedging phrases', on: true, blurb: 'I think, to some extent' },
    { id: 'passiveVoice', label: 'Passive voice', on: true, blurb: 'was broken, had been mended' },
    { id: 'aiPhrases', label: 'AI phrases', on: true, blurb: 'a testament to, rich tapestry' },
    { id: 'aiPatterns', label: 'AI sentence patterns', on: true, blurb: 'not just X, it is Y' },
    { id: 'fillerAdverbs', label: 'Filler adverbs', on: false, blurb: '139 of them; noisy while drafting' },
    { id: 'nominalizations', label: 'Nominalizations', on: false, blurb: 'written for technical prose' },
    { id: 'aiVocabulary', label: 'AI vocabulary', on: false, blurb: 'includes words you may have meant' }
];

const FLAGS_STORE_KEY = 'prose-engine-writing-flags';

/** The writer's choice if they have made one, the defaults if not. */
function chosenFlags() {
    try {
        const saved = JSON.parse(localStorage.getItem(FLAGS_STORE_KEY) || 'null');
        if (Array.isArray(saved)) return new Set(saved);
    } catch {
        // A corrupt entry is not worth losing the menu over.
    }
    return new Set(FLAG_FAMILIES.filter(f => f.on).map(f => f.id));
}

/*
   Announced rather than called. The editor section is injected on navigation
   and the rail is not, so this menu cannot hold a reference to the editor -
   the same reason `runReview` is an event. Editor.js listens and re-arms the
   surface; with no editor on screen nobody listens, and the choice is still
   saved for when one appears.
*/
function publishFlags(chosen) {
    try {
        localStorage.setItem(FLAGS_STORE_KEY, JSON.stringify([...chosen]));
    } catch {
        // Private browsing. The choice still applies for this session.
    }
    document.dispatchEvent(new CustomEvent('writingFlagsChanged', {
        detail: { categories: [...chosen] }
    }));
    drawFlagsValue();
}

function drawFlagsValue() {
    if (!els.flagsValue) return;
    const on = chosenFlags().size;
    els.flagsValue.textContent = on ? `${on} of ${FLAG_FAMILIES.length}` : 'off';
}

function drawFlagsList() {
    const chosen = chosenFlags();

    /*
       The master switch, first and separated. It is the row a writer comes to
       this menu for - the underlines are already on the page and they want
       them gone - so it must not be eight clicks at the bottom of a list.

       It reads as ON if anything at all is ticked, because that matches what
       is on the page rather than what is in the config.
    */
    const anyOn = chosen.size > 0;
    const master = `
        <button type="button" class="rail-menu__item rail-menu__toggle" role="menuitemcheckbox"
            aria-checked="${anyOn}" data-flags-master
            title="Underline weak or machine-sounding phrasing as you write. Local: no AI, nothing sent anywhere.">
            <span class="rail-menu__label">Underline as I write</span>
            <span class="rail-menu__switch" aria-hidden="true"></span>
        </button>
        <div class="rail-menu__divider" role="separator"></div>`;

    const rows = FLAG_FAMILIES.map(family => `
        <button type="button" class="rail-menu__item rail-menu__toggle" role="menuitemcheckbox"
            aria-checked="${chosen.has(family.id)}" data-flag="${escapeHtml(family.id)}"
            title="${escapeHtml(family.blurb)}">
            <span class="rail-menu__label">${escapeHtml(family.label)}</span>
            <span class="rail-menu__switch" aria-hidden="true"></span>
        </button>`).join('');

    els.flagsFlyout.innerHTML = master + rows;
}

function onFlagsClick(event) {
    const master = event.target.closest('[data-flags-master]');
    if (master) {
        /*
           Off means off: everything unticked. On restores the family defaults
           rather than "whatever was on last time" - the writer who switched
           this off in frustration and back on a week later wants the thing
           that works, not a set they no longer remember choosing.
        */
        const goingOff = chosenFlags().size > 0;
        publishFlags(goingOff ? new Set() : new Set(FLAG_FAMILIES.filter(f => f.on).map(f => f.id)));
        drawFlagsList();
        return;
    }

    const toggle = event.target.closest('[data-flag]');
    if (!toggle) return;

    const id = toggle.dataset.flag;
    const chosen = chosenFlags();
    if (chosen.has(id)) chosen.delete(id); else chosen.add(id);

    publishFlags(chosen);
    toggle.setAttribute('aria-checked', String(chosen.has(id)));
    // The master switch reflects the page, so it has to follow the last family
    // being switched off.
    els.flagsFlyout.querySelector('[data-flags-master]')
        ?.setAttribute('aria-checked', String(chosen.size > 0));
}

/* ---------- the badge ---------- */

/**
 * What the last scan found, carried on the rail so the writer can shut the
 * drawer and keep the number. Errors colour it; style findings do not, because
 * a chapter with twelve long sentences is not a chapter with twelve problems.
 */
function drawBadge(detail = {}) {
    if (!els.badge) return;

    const total = Number(detail.total) || 0;
    if (!total) {
        els.badge.classList.add('hidden');
        els.badge.textContent = '';
        return;
    }

    els.badge.textContent = total > 99 ? '99+' : String(total);
    els.badge.classList.remove('hidden');
    els.badge.classList.toggle('studio-rail__badge--error', Number(detail.error) > 0);
}

function note(message) {
    return `<p class="rail-menu__note">${escapeHtml(message)}</p>`;
}
