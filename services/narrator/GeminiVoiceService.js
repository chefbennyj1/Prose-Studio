// services/narrator/GeminiVoiceService.js

const GeminiClient = require('../gemini/GeminiClient');

/**
 * GeminiVoiceService
 *
 * The second narrator. Piper writes, this one performs.
 *
 * WHY TWO ENGINES AND NOT A BETTER ONE. Piper is local, free, instant and
 * unlimited, which is what listening to a chapter you are still rewriting
 * needs. It is also, unavoidably, flat - it has no idea what the words mean.
 * This one takes DIRECTION in plain English ("noir, cyberpunk, English accent,
 * not drawn out") and acts the line, and it is metered. So Piper stays on the
 * revision loop where the text changes hourly, and this renders the finished
 * take. Nothing is spent on prose that is still moving.
 *
 * It deliberately matches PiperService.speak's signature and return shape:
 *
 *     speak(voice, text, opts) -> { audio: Float32Array, sampleRate, chunks }
 *
 * That is the whole integration. Everything above that line - TextPlan's
 * Markdown stripping and pronunciation lexicon, paragraph segmentation, the
 * scene-break silences, content-hash caching, the manifest - is engine
 * agnostic and already written.
 *
 * WHY RAW fetch AND NOT THE SDK. The @google/generative-ai client wraps
 * generateContent for text; the audio path needs responseModalities and
 * speechConfig, and the models return headerless PCM. Going direct keeps the
 * request obvious and the failure messages intact. The KEY and the consent
 * gate still come from GeminiClient, which is the only thing that may decide
 * whether this is allowed to run at all.
 */

/*
 * Every TTS model on this account is a PREVIEW model, and preview models get
 * renamed and withdrawn. It is a default, not a constant: a caller can pass
 * another, so a model disappearing is a settings change rather than a code
 * change and a re-render.
 */
const DEFAULT_MODEL = 'gemini-3.1-flash-tts-preview';

/** Voice. Zephyr with an English-accent instruction is Ben's. */
const DEFAULT_VOICE = 'Zephyr';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Thrown when the daily free allowance is gone.
 *
 * A distinct code because it is not a failure - it is "come back tomorrow",
 * and the export renderer stops politely on it and keeps everything already
 * rendered. Anything else is a real error and should surface as one.
 */
class QuotaReached extends Error {
    constructor(message) {
        super(message);
        this.code = 'TTS_QUOTA';
    }
}

class GeminiVoiceService {

    get defaultVoice() { return DEFAULT_VOICE; }
    get defaultModel() { return DEFAULT_MODEL; }

    /** Is the AI switched on and is there a key? Same gate as everything else. */
    availability() {
        return GeminiClient.availability();
    }

    /**
     * One paragraph, spoken.
     *
     * @param {string} voice   a prebuilt voice name, e.g. "Zephyr"
     * @param {string} text    the paragraph, already stripped of Markdown by TextPlan
     * @param {object} opts    { style, model }
     * @returns {Promise<{audio: Float32Array, sampleRate: number, chunks: number, tokens: number}>}
     */
    async speak(voice, text, opts = {}) {
        const available = await this.availability();
        if (!available.ok) throw new Error(available.reason);

        const clean = String(text || '').replace(/\s+/g, ' ').trim();
        if (!clean) return { audio: new Float32Array(0), sampleRate: 24000, chunks: 0, tokens: 0 };

        const key = await GeminiClient.getApiKey();
        const model = opts.model || DEFAULT_MODEL;
        const style = String(opts.style || '').trim();

        /*
         * The direction rides in front of the text. These models have no
         * separate style field - the instruction and the line to speak arrive
         * as one prompt, and the model works out which is which. Two newlines
         * between them, because on one line it will occasionally read the
         * instruction aloud.
         */
        const prompt = style ? `${style}\n\n${clean}` : clean;

        const response = await fetch(`${ENDPOINT}/${model}:generateContent?key=${key}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    responseModalities: ['AUDIO'],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || DEFAULT_VOICE } }
                    }
                }
            })
        });

        const raw = await response.text();
        let body;
        try {
            body = JSON.parse(raw);
        } catch {
            throw new Error(`The voice service returned something unreadable (HTTP ${response.status}).`);
        }

        if (!response.ok) {
            const message = body?.error?.message || `HTTP ${response.status}`;
            // GeminiClient.explain turns Google's prose into a sentence a
            // writer can act on, and knows a daily cap from an outage.
            const said = GeminiClient.explain(new Error(message));
            if (response.status === 429 || /quota|PerDay|rate limit/i.test(message)) {
                throw new QuotaReached(said);
            }
            throw new Error(said);
        }

        const part = body.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
        if (!part) {
            /*
             * A 200 with no audio. Usually a safety block or a finishReason
             * other than STOP - say which, because "no audio" on its own sends
             * someone looking for a network problem that is not there.
             */
            const reason = body.candidates?.[0]?.finishReason || 'no reason given';
            throw new Error(`The voice returned no audio for this paragraph (${reason}).`);
        }

        const sampleRate = rateFrom(part.inlineData.mimeType);
        const pcm = Buffer.from(part.inlineData.data, 'base64');

        return {
            audio: toFloat32(pcm),
            sampleRate,
            // A paragraph is one utterance here. Piper counts sentences because
            // it renders them separately; this model holds prosody across the
            // whole paragraph, which is most of why it sounds acted.
            chunks: 1,
            tokens: body.usageMetadata?.totalTokenCount || 0
        };
    }
}

/**
 * "audio/l16; rate=24000; channels=1" -> 24000.
 *
 * Read rather than assumed: the rate goes into the WAV header, and a file
 * written with the wrong one plays at the wrong speed and pitch. 24000 is the
 * observed default and the fallback, not a constant to rely on.
 */
function rateFrom(mimeType) {
    const found = /rate=(\d+)/.exec(mimeType || '');
    return found ? Number(found[1]) : 24000;
}

/**
 * Signed 16-bit little-endian PCM -> Float32 in [-1, 1], which is the shape
 * ChapterAudioService's wav writer and Piper both work in.
 *
 * 32768 rather than 32767: the negative extreme of a signed 16-bit sample is
 * -32768, and dividing by 32767 puts it fractionally past -1.0, where the wav
 * writer's clamp catches it. Audible as a tick on a loud sample.
 */
function toFloat32(pcm) {
    const count = Math.floor(pcm.length / 2);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
    return out;
}

module.exports = new GeminiVoiceService();
module.exports.QuotaReached = QuotaReached;
