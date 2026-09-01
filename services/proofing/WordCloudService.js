// services/proofing/WordCloudService.js

const { stripMarkdown } = require('../narrator/TextPlan');
const { splitParagraphs, findQuotes, makeInQuote } = require('./MechanicsText');

/**
 * WordCloudService
 *
 * What a story is made of, by weight. Local, exact, no model.
 *
 * WHY THIS IS NOT A FREQUENCY COUNT.
 *
 * The most common words in any novel are the, and, she, was, said. A cloud
 * built on raw counts shows those, every time, for every book ever written -
 * which is a picture of English, not of this manuscript. It is the same trap
 * the thesaurus panel had to dodge: the obvious implementation produces
 * something that looks like data and tells you nothing.
 *
 * So there are two views, and they answer different questions:
 *
 *   STORY   frequency with stopwords removed. "What is the texture of my
 *           vocabulary" - the nouns and verbs this book is actually built out
 *           of, across everything.
 *
 *   CHAPTER TF-IDF against the rest of the book. "What is THIS chapter about"
 *           - words unusually frequent here compared to everywhere else. A
 *           chapter of neon and rain and noodles scores those, and never
 *           scores "she", because she is in every chapter.
 *
 * The second one is the useful one, and it has a property worth knowing: two
 * chapters whose clouds look alike are two chapters doing the same work. That
 * is a structural note no word count can give you.
 *
 * Dialogue and narration are counted separately, for the same reason
 * OveruseService keeps them apart: a word a character says is characterisation
 * and a word the narrator reaches for is habit. Flattening them together tells
 * a writer with a lot of dialogue that they have a problem they do not have.
 */

/**
 * Function words, dropped before anything is weighed.
 *
 * Deliberately NOT a "top 200 English words" list. Words that carry story -
 * dark, cold, light, hand, eye, door - live in that range and are exactly what
 * the cloud is for. This is grammar only: articles, pronouns, auxiliaries,
 * prepositions, conjunctions, and the handful of verbs too general to mean
 * anything (get, go, make, take).
 */
const STOPWORDS = new Set(`
a about above after again against all am an and any are as at be because been
before being below between both but by can cannot could did do does doing down
during each few for from further had has have having he her here hers herself
him himself his how i if in into is it its itself just me more most my myself
no nor not of off on once only or other ought our ours ourselves out over own
same she should so some such than that the their theirs them themselves then
there these they this those through to too under until up very was we were
what when where which while who whom why with would you your yours yourself
yourselves yet per via own its our his her nor few too eve
aint arent cant couldnt didnt doesnt dont hadnt hasnt havent hes
isnt its lets shes shouldnt thats theres theyre wasnt werent whats wheres whos
wont wouldnt youre youve ive im id ill weve well theyve theyll
get gets got getting go goes going went gone come comes came coming
make makes made making take takes took taken taking put puts putting
say says said saying tell tells told telling
one two three first second next last another every each any
back down out up off away over around
thing things something anything nothing everything someone anyone everyone
because though although since while when whenever wherever however
`.trim().split(/\s+/));

/** Words shown per cloud. Beyond this the tail is a grey haze at 8px. */
const MAX_WORDS = 80;

/**
 * Words shorter than this are dropped.
 *
 * THREE, not four, and a character name is exempt from even that.
 *
 * At four this silently deleted Rin from every cloud in the book - a
 * three-letter protagonist, dropped during counting, before the names list was
 * ever consulted. Ada, Jo, Kim and Sam would have gone the same way. Fiction is
 * full of short names, and a cloud that cannot show the main character is
 * ornamental.
 *
 * Three also keeps eye, arm, gun, sky, bed, war - words a novel leans on. The
 * short function words that leak in at this length are handled where they
 * should be, in the stopword list.
 */
const MIN_LENGTH = 3;

/** A word must appear at least this often to be worth drawing. */
const MIN_COUNT = 3;

class WordCloudService {

    /**
     * @param {Array<{chapter: string, text: string}>} chapters
     * @param {object} opts  { chapter, names }
     *   chapter  name of one chapter for the TF-IDF view; omit for the story view
     *   names    character names, kept whatever their score and marked as names
     * @returns {object} { mode, words, stats }
     */
    build(chapters, opts = {}) {
        const names = new Set((opts.names || []).map(n => n.toLowerCase()));

        // Counted once, used by both views. Names go in so a short one is not
        // dropped by MIN_LENGTH before anything can protect it.
        const perChapter = chapters.map(({ chapter, text }) => ({
            chapter,
            ...this.#count(text, names)
        }));

        return opts.chapter
            ? this.#chapterView(perChapter, opts.chapter, names)
            : this.#storyView(perChapter, names);
    }

    /**
     * The whole book by frequency. Answers "what is my vocabulary made of".
     */
    #storyView(perChapter, names) {
        const total = new Map();
        let words = 0;

        for (const entry of perChapter) {
            words += entry.words;
            for (const [word, count] of entry.counts) {
                const row = total.get(word) || { word, count: 0, dialogue: 0, chapters: 0 };
                row.count += count;
                row.dialogue += entry.dialogue.get(word) || 0;
                row.chapters += 1;
                total.set(word, row);
            }
        }

        const ranked = [...total.values()]
            .filter(row => row.count >= MIN_COUNT || names.has(row.word))
            .map(row => ({ ...row, weight: row.count, isName: names.has(row.word) }))
            .sort((a, b) => b.weight - a.weight)
            .slice(0, MAX_WORDS);

        return {
            mode: 'story',
            words: scale(ranked),
            stats: { words, chapters: perChapter.length, distinct: total.size }
        };
    }

    /**
     * One chapter against the rest. Answers "what is this chapter about".
     *
     * Smoothed IDF - log((1 + N) / (1 + df)) + 1 - rather than the textbook
     * log(N / df). With a dozen chapters the unsmoothed form sends any word
     * appearing in all of them to exactly zero, which silently deletes the
     * protagonist from every cloud. Smoothed, a ubiquitous word scores low
     * instead of vanishing, which is the honest answer: it is present, it is
     * just not what makes this chapter different.
     */
    #chapterView(perChapter, chapterName, names) {
        const target = perChapter.find(entry => entry.chapter === chapterName);
        if (!target) throw new Error(`There is no chapter called "${chapterName}".`);

        const N = perChapter.length;
        const documentFrequency = new Map();
        for (const entry of perChapter) {
            for (const word of entry.counts.keys()) {
                documentFrequency.set(word, (documentFrequency.get(word) || 0) + 1);
            }
        }

        const ranked = [];
        for (const [word, count] of target.counts) {
            if (count < MIN_COUNT && !names.has(word)) continue;

            const tf = count / (target.words || 1);
            const df = documentFrequency.get(word) || 1;
            const idf = Math.log((1 + N) / (1 + df)) + 1;

            ranked.push({
                word,
                count,
                dialogue: target.dialogue.get(word) || 0,
                chapters: df,
                isName: names.has(word),
                weight: tf * idf
            });
        }

        ranked.sort((a, b) => b.weight - a.weight);

        return {
            mode: 'chapter',
            chapter: chapterName,
            words: scale(ranked.slice(0, MAX_WORDS)),
            stats: { words: target.words, chapters: N, distinct: target.counts.size }
        };
    }

    /**
     * One chapter's words, with the dialogue half kept separately.
     *
     * Markdown comes off first - otherwise a chapter full of *emphasis* scores
     * the asterisks into the words, and a heading marker becomes a word.
     */
    #count(text, names = new Set()) {
        const clean = stripMarkdown(String(text || ''));
        const inQuote = makeInQuote(findQuotes(clean, splitParagraphs(clean)));

        const counts = new Map();
        const dialogue = new Map();
        let words = 0;

        // Apostrophes are kept inside a word so "Rin's" counts as "rin's" and
        // is folded below, rather than splitting into "rin" and a stray "s".
        const pattern = /[\p{L}][\p{L}'’-]*/gu;
        let match;
        while ((match = pattern.exec(clean)) !== null) {
            words += 1;

            const word = normalise(match[0]);
            if (!word) continue;
            // A name is never too short and never a stopword. Without this a
            // character called Rin, Jo or Sam is dropped here, and no amount of
            // protecting names further down can bring her back.
            if (!names.has(word) && (word.length < MIN_LENGTH || STOPWORDS.has(word))) continue;

            counts.set(word, (counts.get(word) || 0) + 1);
            if (inQuote(match.index)) dialogue.set(word, (dialogue.get(word) || 0) + 1);
        }

        return { counts, dialogue, words };
    }
}

/**
 * Lowercase, and possessives folded onto the noun.
 *
 * "Rin", "rin" and "Rin's" are one word for counting purposes; leaving them
 * apart splits a protagonist's weight three ways and drops her down the cloud.
 */
function normalise(raw) {
    return raw.toLowerCase()
        .replace(/[’']s$/, '')
        .replace(/^[-']+|[-']+$/g, '');
}

/**
 * Weights to font sizes, 12px to 64px.
 *
 * Square-rooted. Raw weight is heavily skewed - the top word in a novel can be
 * ten times the tenth - and a linear map gives one enormous word and
 * seventy-nine identical small ones. The square root compresses the head
 * without flattening the order, so the cloud stays readable as a ranking.
 */
function scale(words) {
    if (!words.length) return [];
    const top = words[0].weight || 1;
    const floor = words[words.length - 1].weight || 0;
    const span = Math.sqrt(top) - Math.sqrt(floor) || 1;

    return words.map(row => ({
        ...row,
        size: Math.round(12 + 52 * ((Math.sqrt(row.weight) - Math.sqrt(floor)) / span))
    }));
}

module.exports = new WordCloudService();
