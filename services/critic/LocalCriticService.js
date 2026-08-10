const crypto = require('crypto');
const PluginLoader = require('../PluginLoader');
const { getLens } = require('./CriticLenses');

/**
 * LocalCriticService
 *
 * Runs the critic against the Local-Llm-Engine plugin (Gemma 3 4B) so the
 * manuscript never leaves the machine.
 *
 * Two constraints shape everything here, and both come from the 4B:
 *
 * 1. The engine runs llama-server with `-c 8192`. A chapter of prose does not
 *    fit, so the text is split into chunks and each is analysed on its own.
 *    Chunks split on paragraph boundaries — a chunk that starts mid-sentence
 *    produces critique about the truncation rather than the writing.
 * 2. A 4B asked for an essay produces mush. Asked for a fixed JSON shape with
 *    llama-server's `json_schema` grammar, it is reliable — the grammar makes
 *    unparseable output impossible. So each chunk returns structured findings
 *    and the report is assembled in JS. There is no LLM synthesis pass: that
 *    would be one more chance for a small model to invent something.
 *
 * Prompt conventions are lifted from the Proof-Reader plugin, which is the
 * verified-working reference for this model.
 */

// ~4 chars per token. 9000 chars is ~2250 tokens of prose, leaving the 8192
// window comfortable room for the instructions and the model's own output.
const CHUNK_CHARS = 9000;

const FINDING_SCHEMA = {
    type: 'object',
    properties: {
        findings: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    quote: { type: 'string' },
                    note: { type: 'string' }
                },
                required: ['quote', 'note']
            }
        },
        working: {
            type: 'array',
            items: { type: 'string' }
        }
    },
    required: ['findings', 'working']
};

class LocalCriticService {
    constructor() {
        // Must match server.js, which writes the resolved port back into the
        // environment so this agrees with it. The fallback is only for a
        // process that loads this without the server having booted.
        this.port = Number(process.env.PORT) || 3100;
        this.cache = new Map();
    }

    get engineName() {
        return 'local';
    }

    /**
     * The plugin must be enabled before anything else is worth trying. Returns
     * a reason string when unavailable so the caller can tell the writer why
     * rather than surfacing a bare connection error.
     */
    availability() {
        const plugin = PluginLoader.loadedPlugins['Local-Llm-Engine'];
        if (!plugin) {
            return { ok: false, reason: 'The Local-Llm-Engine plugin is not enabled. Enable it in the plugin manager and restart the server.' };
        }
        return { ok: true };
    }

    /**
     * Poll the engine's status endpoint. The model takes ~60s to load from
     * cold, so a first run after a quiet period waits rather than failing.
     */
    async waitForEngine(timeoutMs = 120000) {
        const base = `http://localhost:${this.port}/api/plugins/Local-Llm-Engine`;
        const deadline = Date.now() + timeoutMs;
        let asked = false;

        while (Date.now() < deadline) {
            try {
                const res = await fetch(`${base}/status`);
                const data = await res.json();
                if (data.isRunning) return true;

                // Ask, rather than wait for the dashboard's presence heartbeat
                // to do it — that heartbeat never fires for a plugin enabled
                // after the tab was opened. Not awaited: the model takes ~60s
                // to load and the poll below is already watching for it.
                if (!asked) {
                    asked = true;
                    console.log('[LocalCritic] Engine is down; asking it to start.');
                    fetch(`${base}/start`, { method: 'POST' })
                        .catch(err => console.error('[LocalCritic] Start request failed:', err.message));
                }
            } catch (err) {
                // Engine not answering yet; keep waiting.
            }
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
        return false;
    }

    /**
     * Gemma 3 has no system role: instructions lead the single user turn.
     */
    buildPrompt(instructions, content) {
        return `<start_of_turn>user\n${instructions}\n\n${content}<end_of_turn>\n<start_of_turn>model\n`;
    }

    /**
     * Split on blank lines, packing paragraphs up to CHUNK_CHARS. A paragraph
     * longer than a whole chunk is emitted alone rather than cut mid-sentence.
     */
    chunkText(text) {
        const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
        const chunks = [];
        let current = '';

        for (const para of paragraphs) {
            if (current && current.length + para.length + 2 > CHUNK_CHARS) {
                chunks.push(current);
                current = para;
                continue;
            }
            current = current ? `${current}\n\n${para}` : para;
        }
        if (current) chunks.push(current);
        return chunks;
    }

    async executeLLM(promptString) {
        const response = await fetch(`http://localhost:${this.port}/api/plugins/Local-Llm-Engine/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt: promptString,
                n_predict: 700,
                temperature: 0.2,
                cache_prompt: true,
                json_schema: FINDING_SCHEMA
            })
        });

        const data = await response.json();
        if (!data.ok) throw new Error(`Local engine error: ${data.message}`);

        try {
            const parsed = JSON.parse(data.content);
            return {
                findings: Array.isArray(parsed.findings) ? parsed.findings : [],
                working: Array.isArray(parsed.working) ? parsed.working : []
            };
        } catch (err) {
            console.error('[LocalCritic] Engine returned unparseable output:', data.content);
            return { findings: [], working: [] };
        }
    }

    /**
     * Drop findings whose quote is not actually in the chunk. A 4B will
     * occasionally paraphrase the line it is objecting to, or invent one
     * outright; without this the report cites text the writer never wrote.
     */
    verifyFindings(findings, chunk) {
        const haystack = chunk.toLowerCase();
        const seen = new Set();
        const kept = [];

        for (const finding of findings) {
            const quote = (finding.quote || '').trim();
            const note = (finding.note || '').trim();
            if (!quote || !note) continue;

            // Compare on a trimmed fragment: the model often quotes a clause
            // with different surrounding punctuation than the source.
            const probe = quote.replace(/^["'\s]+|["'\s.,;:!?]+$/g, '').toLowerCase();
            if (probe.length < 8 || !haystack.includes(probe)) continue;

            const key = probe.slice(0, 60);
            if (seen.has(key)) continue;
            seen.add(key);

            kept.push({ quote, note });
        }
        return kept;
    }

    /**
     * Assemble the per-chunk structured results into a Markdown report.
     * Deterministic on purpose — see the class comment.
     */
    renderReport(lens, sections, meta) {
        const lines = [];
        lines.push(`# ${lens.label} — local (Gemma 3 4B)`);
        lines.push('');
        lines.push(`_${lens.blurb}_`);
        lines.push('');
        lines.push(`Analysed ${meta.words.toLocaleString()} words in ${sections.length} chunk(s).`);
        lines.push('');

        const allWorking = sections.flatMap(s => s.working).filter(Boolean);
        if (allWorking.length) {
            lines.push('## What is working');
            lines.push('');
            for (const item of allWorking) lines.push(`- ${item}`);
            lines.push('');
        }

        const totalFindings = sections.reduce((n, s) => n + s.findings.length, 0);
        lines.push('## Findings');
        lines.push('');

        if (totalFindings === 0) {
            lines.push('_No findings under this lens._');
            lines.push('');
        } else {
            sections.forEach((section, i) => {
                if (!section.findings.length) return;
                if (sections.length > 1) {
                    lines.push(`### Part ${i + 1}`);
                    lines.push('');
                }
                for (const finding of section.findings) {
                    lines.push(`- > ${finding.quote}`);
                    lines.push(`  ${finding.note}`);
                    lines.push('');
                }
            });
        }

        if (meta.failedChunks) {
            lines.push('---');
            lines.push('');
            lines.push(`_${meta.failedChunks} chunk(s) failed to analyse and were skipped._`);
        }

        return lines.join('\n');
    }

    /**
     * @param {string} text  The prose to analyse.
     * @param {object} opts  { lens }
     * @returns {Promise<string>} Markdown critique.
     */
    async analyze(text, opts = {}) {
        const available = this.availability();
        if (!available.ok) throw new Error(available.reason);

        const lens = getLens(opts.lens);
        const body = (text || '').trim();
        if (!body) throw new Error('There is no text to critique.');

        const cacheKey = crypto.createHash('sha1').update(`${lens.id}:${body}`).digest('hex');
        if (this.cache.has(cacheKey)) {
            console.log('[LocalCritic] Returning cached critique.');
            return this.cache.get(cacheKey);
        }

        if (!(await this.waitForEngine())) {
            throw new Error('The local LLM engine was asked to start but did not come up within two minutes. Check the model path in the plugin manager and the server log for [LocalLlmEngine].');
        }

        const chunks = this.chunkText(body);
        console.log(`[LocalCritic] Lens "${lens.id}": analysing ${chunks.length} chunk(s)...`);

        const instructions =
            'You are a working fiction editor reviewing a passage of prose.\n\n' +
            `${lens.focus}\n\n` +
            'Rules:\n' +
            '- Quote the exact text you are commenting on, word for word from the passage. Never paraphrase a quote.\n' +
            '- Keep each note under 30 words and make it actionable.\n' +
            '- Only report genuine problems. Never include an entry to say something is fine.\n' +
            '- Strong passages legitimately have few findings; an empty findings array is a valid answer.\n' +
            '- In "working", list up to three things the passage does well. Be specific, not flattering.';

        const sections = [];
        let failedChunks = 0;

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            console.log(`[LocalCritic] Chunk ${i + 1}/${chunks.length} (${chunk.length} chars)...`);
            try {
                const result = await this.executeLLM(this.buildPrompt(instructions, `PASSAGE:\n${chunk}`));
                sections.push({
                    findings: this.verifyFindings(result.findings, chunk),
                    working: result.working.map(w => String(w).trim()).filter(Boolean).slice(0, 3)
                });
            } catch (err) {
                console.error(`[LocalCritic] Chunk ${i + 1} failed:`, err.message);
                failedChunks++;
                sections.push({ findings: [], working: [] });
            }
        }

        if (failedChunks === chunks.length) {
            throw new Error('Every chunk failed to analyse. Check that the local LLM engine is running.');
        }

        const report = this.renderReport(lens, sections, {
            words: body.split(/\s+/).filter(Boolean).length,
            failedChunks
        });

        if (this.cache.size >= 20) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(cacheKey, report);

        console.log('[LocalCritic] Analysis complete.');
        return report;
    }
}

module.exports = new LocalCriticService();
