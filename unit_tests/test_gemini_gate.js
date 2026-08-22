/**
 * The consent gate, with an API key sitting in the environment the whole time.
 *
 * That is the case that was broken: an env key satisfied the gate on its own,
 * so switching the AI off in Settings did not switch it off. Every case below
 * runs WITH process.env.GEMINI_API_KEY set, because that is the only way to
 * tell whether the checkbox is being read at all.
 *
 * GlobalSettings is stubbed through the require cache, so this needs no Mongo.
 */
const path = require('path');
const ROOT = 'E:/Prose Engine';

process.env.GEMINI_API_KEY = 'env-key-pretending-to-be-consent';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const SETTINGS_PATH = require.resolve(path.join(ROOT, 'models/GlobalSettings'));

let stub = { findOne: async () => null };
require.cache[SETTINGS_PATH] = {
    id: SETTINGS_PATH, filename: SETTINGS_PATH, loaded: true,
    exports: { findOne: (...args) => stub.findOne(...args) }
};

const GeminiClient = require(path.join(ROOT, 'services/gemini/GeminiClient'));

const cases = [
    {
        name: 'AI switched OFF in Settings, env key present',
        settings: async () => ({ critic: { enabled: false, apiKey: null } }),
        expect: false
    },
    {
        name: 'No settings document at all (fresh install), env key present',
        settings: async () => null,
        expect: false
    },
    {
        name: 'Settings unreadable (database down), env key present',
        settings: async () => { throw new Error('connection refused'); },
        expect: false
    },
    {
        name: 'AI switched ON, key from the environment',
        settings: async () => ({ critic: { enabled: true, apiKey: null } }),
        expect: true
    },
    {
        name: 'AI switched ON but no key anywhere',
        settings: async () => ({ critic: { enabled: true, apiKey: null } }),
        noEnvKey: true,
        expect: false
    }
];

(async () => {
    let failures = 0;

    for (const test of cases) {
        stub.findOne = test.settings;

        const saved = process.env.GEMINI_API_KEY;
        if (test.noEnvKey) delete process.env.GEMINI_API_KEY;

        let result;
        try {
            result = await GeminiClient.availability();
        } catch (err) {
            result = { ok: 'THREW: ' + err.message };
        }

        if (test.noEnvKey) process.env.GEMINI_API_KEY = saved;

        const pass = result.ok === test.expect;
        if (!pass) failures++;
        console.log(`${pass ? 'PASS' : 'FAIL'}  ${test.name}`);
        console.log(`      ok=${result.ok} (expected ${test.expect})`);
        if (result.reason) console.log(`      "${result.reason}"`);
    }

    // The gate is only worth anything if getModel() honours it too - that is
    // the call that actually builds a client and would send the manuscript.
    stub.findOne = async () => ({ critic: { enabled: false } });
    let blocked = false;
    try {
        await GeminiClient.getModel();
    } catch (err) {
        blocked = true;
        console.log(`PASS  getModel() refuses when the AI is off`);
        console.log(`      "${err.message}"`);
    }
    if (!blocked) {
        failures++;
        console.log('FAIL  getModel() handed back a model with the AI switched off');
    }

    console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
    process.exit(failures ? 1 : 0);
})();
