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

let critic = null;      // { engines, lenses, defaultEngine, defaultLens }
let ruleset = null;     // { groups, rules, defaults }
let els = {};

let choice = {
    lens: null,
    engine: null,
    disabled: []
};

export function initReviewMenu() {
    els = {
        badge: document.getElementById('reviewBadge'),
        critiqueHint: document.getElementById('reviewCritiqueHint'),
        lensValue: document.getElementById('reviewLensValue'),
        lensFlyout: document.getElementById('reviewLensFlyout'),
        engineValue: document.getElementById('reviewEngineValue'),
        engineFlyout: document.getElementById('reviewEngineFlyout'),
        rulesValue: document.getElementById('reviewRulesValue'),
        rulesFlyout: document.getElementById('reviewRulesFlyout')
    };
    if (!els.lensFlyout) return;

    restore();

    document.querySelectorAll('[data-review]').forEach((button) => {
        // No stopPropagation: the click should reach the document handler that
        // closes the menu. Starting a check is the last thing you do here.
        button.addEventListener('click', () => start(button.dataset.review));
    });

    els.lensFlyout.addEventListener('click', onLensClick);
    els.engineFlyout.addEventListener('click', onEngineClick);
    els.rulesFlyout.addEventListener('click', onRuleClick);

    submenu('lens')?.addEventListener('flyoutOpened', drawLensList);
    submenu('engine')?.addEventListener('flyoutOpened', drawEngineList);
    submenu('rules')?.addEventListener('flyoutOpened', drawRuleList);

    document.addEventListener('reviewFinished', (event) => drawBadge(event.detail));


    loadCritic();
    loadRules();
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
            engine: choice.engine,
            mechanics: getMechanicsOptions()
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

/* ---------- persistence ---------- */

function restore() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
        choice.lens = saved.lens || null;
        choice.engine = saved.engine || null;
        choice.disabled = Array.isArray(saved.disabled) ? saved.disabled : [];
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

        // A remembered engine that is no longer available - the plugin was
        // turned off, the API key was removed - has to fall back, or Critique
        // fails on a choice the writer made weeks ago and has forgotten.
        const engine = critic.engines.find(e => e.id === choice.engine);
        if (!engine || !engine.ok) {
            choice.engine = (critic.engines.find(e => e.id === critic.defaultEngine && e.ok)
                || critic.engines.find(e => e.ok)
                || {}).id || critic.defaultEngine;
        }

        drawCriticValues();
    } catch (err) {
        console.error('[ReviewMenu] Could not load critic options', err);
        if (els.lensValue) els.lensValue.textContent = 'unavailable';
    }
}

function drawCriticValues() {
    if (!critic) return;

    const lens = critic.lenses.find(l => l.id === choice.lens);
    const engine = critic.engines.find(e => e.id === choice.engine);

    if (els.lensValue) els.lensValue.textContent = lens ? lens.label : '';
    if (els.engineValue) els.engineValue.textContent = engine ? shortEngine(engine.label) : '';
    if (els.critiqueHint) els.critiqueHint.textContent = engine ? shortEngine(engine.label) : '';
}

/** "Local (Gemma 3 4B)" is too wide for a rail row; the rest is in the flyout. */
function shortEngine(label) {
    return String(label).replace(/\s*\(.*$/, '');
}

function drawLensList() {
    if (!critic) {
        els.lensFlyout.innerHTML = note('Loading...');
        return;
    }
    els.lensFlyout.innerHTML = critic.lenses.map(lens => `
        <button type="button" class="rail-menu__item rail-menu__entry${lens.id === choice.lens ? ' is-active' : ''}"
            role="menuitemradio" aria-checked="${lens.id === choice.lens}" data-id="${escapeHtml(lens.id)}">
            <span class="rail-menu__name">${escapeHtml(lens.label)}</span>
            <span class="rail-menu__count">${escapeHtml(lens.blurb)}</span>
        </button>`).join('');
}

function drawEngineList() {
    if (!critic) {
        els.engineFlyout.innerHTML = note('Loading...');
        return;
    }
    els.engineFlyout.innerHTML = critic.engines.map(engine => `
        <button type="button" class="rail-menu__item rail-menu__entry${engine.id === choice.engine ? ' is-active' : ''}"
            role="menuitemradio" aria-checked="${engine.id === choice.engine}"
            data-id="${escapeHtml(engine.id)}" ${engine.ok ? '' : 'disabled'}>
            <span class="rail-menu__name">${escapeHtml(engine.label)}</span>
            <span class="rail-menu__count">${escapeHtml(engine.ok ? engine.blurb : engine.reason)}</span>
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

function onEngineClick(event) {
    const entry = event.target.closest('.rail-menu__entry');
    if (!entry || entry.disabled) return;
    choice.engine = entry.dataset.id;
    remember();
    drawCriticValues();
    drawEngineList();
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
