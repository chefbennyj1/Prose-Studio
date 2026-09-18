// Screenshots for the README, taken from the running app.
//
//     node scripts/screenshots.js
//
// Repeatable on purpose: a screenshot pasted in by hand is out of date the
// moment the interface moves, and nobody ever notices. This boots a throwaway
// instance on port 3193 with its OWN data folder and its OWN demo story, so it
// cannot touch a real installation, and writes straight into docs/screenshots.
//
// The demo prose is original and lives in demo-prose.js, seeded with the things
// the scans are meant to find so the review panel has something honest to show.
// Needs the dev dependencies installed (puppeteer).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer');
const { CHAPTER_ONE, CHAPTER_TWO } = require('./demo-prose.js');

const PORT = 3193;
const BASE = `http://127.0.0.1:${PORT}`;
const APP = path.join(__dirname, '..');
const OUT = path.join(APP, 'docs', 'screenshots');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prose-shots-'));
const storyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prose-demo-'));
const PASSWORD = 'a good long password';

const shots = [];
const shoot = async (page, name, options = {}) => {
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, ...options });
    const kb = Math.round(fs.statSync(file).size / 1024);
    shots.push({ name, kb });
    console.log(`  shot  ${name}.png  (${kb} KB)`);
};

const story = path.join(storyRoot, 'The Salt Road');
fs.mkdirSync(story, { recursive: true });
fs.writeFileSync(path.join(story, 'One — The Field at the End.md'), CHAPTER_ONE, 'utf8');
fs.writeFileSync(path.join(story, 'Two — Ordish.md'), CHAPTER_TWO, 'utf8');

function startServer() {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['server.js'], {
            cwd: APP,
            env: { ...process.env, PROSE_DATA_DIR: dataDir, PROSE_CONFIG_FILE: path.join(dataDir, 'config.json'), PORT: String(PORT) }
        });
        let out = '';
        const onData = c => { out += c.toString(); if (out.includes('Website running on')) { child.stdout.off('data', onData); resolve(child); } };
        child.stdout.on('data', onData);
        child.stderr.on('data', c => { out += c.toString(); });
        child.on('exit', code => { if (!out.includes('Website running on')) reject(new Error(`exited ${code}:\n${out}`)); });
        setTimeout(() => reject(new Error('never started:\n' + out)), 30000);
    });
}

function request(method, pathname, body, cookie) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: pathname, method,
            headers: {
                Accept: 'application/json',
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...(cookie ? { Cookie: cookie } : {})
            }
        }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => resolve({
                status: res.statusCode,
                cookie: (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; '),
                body: (() => { try { return JSON.parse(d); } catch { return null; } })()
            }));
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

const settle = (ms = 700) => new Promise(r => setTimeout(r, ms));

(async () => {
    console.log(`\nDemo story: ${story}\n`);
    const server = await startServer();

    // --- the setup wizard, before an account exists -------------------------
    const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1400, height: 940 } });
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('   page error:', String(e).slice(0, 120)));

    await page.goto(`${BASE}/setup`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-step="admin"].is-active', { timeout: 20000 });
    await settle(400);
    await shoot(page, 'setup');

    // --- make the account and point it at the demo story --------------------
    await request('POST', '/setup/admin', { username: 'Mara', email: 'writer@example.com', password: PASSWORD, confirmPassword: PASSWORD });
    const login = await request('POST', '/authentication/login', { email: 'writer@example.com', password: PASSWORD });
    await request('PUT', '/api/settings/global', { settings: { storage: { storyRoot } } }, login.cookie);

    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
    await page.type('input[type="email"], #email', 'writer@example.com');
    await page.type('input[type="password"], #password', PASSWORD);
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }).catch(() => {}),
        page.click('button[type="submit"]')
    ]);

    await page.evaluate(() => localStorage.setItem('prose_engine_last_place',
        JSON.stringify({ story: 'The Salt Road', chapter: 'One — The Field at the End' })));
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cm-content', { timeout: 30000 });
    await settle(1200);

    // Dismiss the welcome toast so it is not in every shot.
    await page.evaluate(() => document.querySelectorAll('.toast, [class*="toast"]').forEach(n => n.remove()));

    // --- the editor ---------------------------------------------------------
    await shoot(page, 'editor');

    // --- the editor, scrolled to a page rule --------------------------------
    const foundRule = await page.evaluate(async () => {
        const scroller = document.querySelector('.cm-scroller');
        for (let i = 0; i < 40; i++) {
            const rule = document.querySelector('.cm-pageBreak');
            if (rule) {
                const r = rule.getBoundingClientRect();
                const s = scroller.getBoundingClientRect();
                // Put the rule around two thirds down, with prose above and below.
                scroller.scrollTop += (r.top - s.top) - s.height * 0.62;
                await new Promise(res => setTimeout(res, 300));
                return true;
            }
            scroller.scrollTop += 300;
            await new Promise(res => setTimeout(res, 120));
        }
        return false;
    });
    await settle(500);
    if (foundRule) await shoot(page, 'page-rules');
    else console.log('  !!    no page rule found to photograph');

    // --- the word cloud -----------------------------------------------------
    const cloudBtn = await page.$('[data-target="word-cloud"]');
    if (cloudBtn) {
        await cloudBtn.click();
        await settle(2500);

        // The cloud floats in the middle of a tall empty canvas. Cropped to the
        // words plus the header, so the README shows the feature rather than an
        // acre of background.
        const clip = await page.evaluate(() => {
            const words = [...document.querySelectorAll('#wordCloud text, .word-cloud text, svg text')];
            if (!words.length) return null;
            const boxes = words.map(n => n.getBoundingClientRect());
            const left = Math.min(...boxes.map(b => b.left));
            const right = Math.max(...boxes.map(b => b.right));
            const bottom = Math.max(...boxes.map(b => b.bottom));
            return {
                x: Math.max(0, left - 220),
                y: 0,
                width: Math.min(window.innerWidth, (right - left) + 440),
                height: Math.min(window.innerHeight, bottom + 90)
            };
        });

        await shoot(page, 'word-cloud', clip ? { clip } : {});
    } else {
        console.log('  !!    word cloud button not found');
    }

    // --- the review menu, with a scan run -----------------------------------
    await (await page.$('[data-target="editor"]'))?.click();
    await settle(900);
    const review = await page.$('.rail-menu__trigger[title="Review"]');
    if (review) {
        await review.click();
        await settle(900);
        await shoot(page, 'review-menu');

        // Run the weak-adverb scan and photograph what it reports. This is the
        // feature the README leads with, and a menu listing it proves nothing.
        const ran = await page.evaluate(() => {
            const row = [...document.querySelectorAll('button, [role="menuitem"], a')]
                .find(n => /weak\s*adverbs/i.test(n.textContent || ''));
            if (!row) return false;
            row.click();
            return true;
        });

        if (ran) {
            // The scan reads the whole story from disk; give it room.
            await settle(6000);
            await page.evaluate(() => document.querySelectorAll('.toast, [class*="toast"]').forEach(n => n.remove()));
            await shoot(page, 'weak-adverbs');
        } else {
            console.log('  !!    could not find the weak adverbs row');
        }
    } else {
        console.log('  !!    review trigger not found');
    }

    await browser.close();
    server.kill();

    console.log(`\n${shots.length} screenshots in ${OUT}`);
    console.log(`total ${shots.reduce((a, s) => a + s.kb, 0)} KB`);
    process.exit(0);
})().catch(err => { console.error('\nSHOOT FAILED:', err.message); process.exit(1); });
