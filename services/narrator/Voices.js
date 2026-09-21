// services/narrator/Voices.js

/**
 * Which engine speaks a given voice.
 *
 * There are two narrators now and they are good at opposite things:
 *
 *   PIPER   renders at about four times real time, so it can keep ahead of
 *           someone pressing play and listening as they write. It sounds like
 *           a machine reading.
 *   KOKORO  renders at about 0.7 times real time — slower than you can listen
 *           to it — and sounds like a person telling you something.
 *
 * Neither replaces the other, so both stay: Piper for hearing a paragraph back
 * while you work, Kokoro for the version worth keeping. Measured on this
 * machine with the same paragraph: Piper 18.5s of audio in 5.1s, Kokoro 16.6s
 * in 17.9s.
 *
 * ## Both versions survive on disk, for free
 *
 * ChapterAudioService hashes voice, speaker, pace and text together to name a
 * rendered file, so a paragraph spoken by Piper and the same paragraph spoken
 * by Kokoro were always going to be two different files. Nothing had to be
 * added to keep both.
 *
 * ## The id says the engine
 *
 * A Kokoro voice is `kokoro:af_heart`; a Piper voice is `en_GB-alan-medium`.
 * That is the whole dispatch rule, and it is why nothing above this file needs
 * to know there is more than one engine — the voice id a writer picked in the
 * menu last month still routes correctly today.
 */

const Piper = require('./PiperService');
const PiperVoices = require('./PiperVoices');
const Kokoro = require('./KokoroService');

/** The engine that owns this id. Piper is the default, as it always was. */
function engineFor(id) {
    return Kokoro.owns(id) ? Kokoro : null;
}

module.exports = {
    Piper,
    Kokoro,

    isKokoro: (id) => Kokoro.owns(id),

    /** Speak. Same signature and return shape whichever engine answers. */
    async speak(id, text, opts = {}) {
        const engine = engineFor(id);
        return engine ? engine.speak(id, text, opts) : Piper.speak(id, text, opts);
    },

    async unload(id) {
        const engine = engineFor(id);
        return engine ? engine.unload(id) : Piper.unload(id);
    },

    async speakers(id) {
        const engine = engineFor(id);
        return engine ? engine.speakers(id) : PiperVoices.speakers(id);
    },

    async isInstalled(id) {
        const engine = engineFor(id);
        return engine ? engine.isInstalled(id) : PiperVoices.isInstalled(id);
    },

    async install(id, onProgress) {
        const engine = engineFor(id);
        return engine ? engine.install(id, onProgress) : PiperVoices.install(id, onProgress);
    },

    async remove(id) {
        const engine = engineFor(id);
        return engine ? engine.remove(id) : PiperVoices.remove(id);
    },

    /** Is anything at all installed to speak with? */
    async ready() {
        return (await Piper.ready()) || (await Kokoro.ready());
    },

    /** Every installed voice id, from both engines. */
    async installed() {
        const [piper, kokoroReady] = await Promise.all([PiperVoices.installed(), Kokoro.isInstalled()]);
        if (!kokoroReady) return piper;

        const kokoro = (await Kokoro.catalogue()).map(v => v.id);
        return [...piper, ...kokoro];
    },

    /**
     * The whole catalogue, both engines, with Kokoro first.
     *
     * Kokoro leads because it is the one a writer will want for anything they
     * intend to listen to properly, and burying it under 171 Piper voices
     * would hide the better option behind a scroll.
     *
     * A failure to reach Piper's index must not take Kokoro's list with it:
     * they are fetched independently and either can be missing.
     */
    async catalogue() {
        let piper = [];
        let error = null;

        try {
            piper = (await PiperVoices.catalogue()).map(v => ({ ...v, engine: 'piper' }));
        } catch (err) {
            error = err.message;
        }

        let kokoro = [];
        try {
            kokoro = await Kokoro.catalogue();
        } catch (err) {
            if (!error) error = err.message;
        }

        return { voices: [...kokoro, ...piper], error };
    }
};
