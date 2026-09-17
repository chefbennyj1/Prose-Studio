## Agent Status
<!-- Update your line before starting work. Clear it when done. -->
**GEMINI:** idle
**CLAUDE:** idle — 2026-09-17. **MongoDB is gone.** The engine stores its records
as encrypted files in `data/` beside the app, unlocked at sign-in by the writer's
own password. Also gone: .env, dotenv, connect-mongo, mongoose. Verified with four
drivers, 143 checks, including a real browser run of the first-run wizard.

- **services/db/** is a drop-in for the slice of mongoose this app used, so the
  models and every controller read as they always did — only the `require` line
  in each model changed. Unsupported query/update operators THROW rather than
  silently matching nothing: add them in `query.js` rather than working around
  one. Files carry no extension and are AES-256-GCM; `keywrap.json` is the only
  readable file in the folder and must stay that way.
- **services/config/Vault.js** — the password derives (scrypt) a wrapping key,
  which unwraps a random DATA key, which encrypts the files. The indirection is
  the design: a password change rewraps one small key instead of re-encrypting
  the folder, several accounts can each hold their own wrap of the same key, and
  a RECOVERY CODE is just another wrap. Unwrapping is also authentication —
  GCM fails on the wrong key — which is what resolves the chicken-and-egg of
  user records living inside the thing you need a password to open.
- **The app boots LOCKED.** Nothing is readable before a sign-in, so the
  manuscript watcher starts on first unlock (`Vault.onUnlock`) rather than at
  boot. The setup gate now has three states: no account -> /setup, locked ->
  /login, unlocked -> through. Sessions are in memory, because a session that
  outlived the process would be a key to a door that is already bolted.
- **Reading while locked MUST throw, and that is a data-loss guard, not tidiness.**
  An earlier version asked for the key, got "locked", took it for "this file will
  not decrypt", moved the writer's data file aside and carried on empty — on a
  plain read. `assertUnlocked()` in Store.js runs before any file work, and Vault
  errors carry `code: 'LOCKED'` so the two cases can never be confused again.
- **`secret: true` in a schema is ENFORCED**, not a comment: the store refuses to
  write the Gemini key or the GitHub token unless the value is already
  ciphertext. Forgetting to encrypt is now a loud error at the write.
- **Found en route, pre-existing:** StorageService caches the story root and only
  `setStoryRoot()` busted that cache, so setting the folder from the Settings
  screen left the engine on the OLD root until a restart. Fixed in
  SystemSettingsController.
- **Ben must re-enter his Gemini key and story root** — the old Mongo data is not
  migrated. His .env still exists on disk and is no longer read by anything.
- **Deliberately not done:** per-user data isolation. Every account unwraps the
  same data key, which matches what the app already was (roles guarded the
  routes; Mongo had no per-user boundary either). Storage is the wrong layer for
  that boundary — it belongs in route-level ownership checks. Also not done: the
  Electron packaging this was groundwork for. A writer-facing README now exists.

**CLAUDE (previous):** idle — 2026-09-16. Ben confirmed per-chapter music plays correctly
in the app; the Music level stepper has not been separately confirmed:
- **Chapter settings live in a header at the top of the chapter's .md**
  (`services/manuscript/ChapterHeader.js`). Only keys in `KEYS` count (just
  `music` today), so a scene break or `Tuesday: morning` is never taken for
  one. `ManuscriptService.read` returns the body only (plus `meta`); `write`
  puts the disk header back on top; `setMeta` edits it (GET/POST
  `/api/manuscript/meta`). TextPlan strips it again as a second guard. **Any
  new code that reads a chapter must go through ManuscriptService** or it
  will see the header. Sidecar .json was rejected: renames would orphan it.
- Narrator menu: "Chapter music" row (Default / None / track; `music: none` =
  silent on purpose) follows `manuscriptOpened`; saving fires
  `chapterMetaSaved` so the Editor adopts the new mtime.
- "Music level" stepper (5% steps, localStorage `narrator_music_volume`,
  default 12%). MusicBed.setVolume uses clearSchedule; start() resets master gain.
Service round-trip tested in node against a temp folder. Before that: Weak-adverb scan built and
wired (see below). Server-side
driven and verified; the PANEL IS UNVERIFIED IN A BROWSER, because the dev
server on 3100 was running stale code and I did not restart Ben's instance.
Previously: Review menu toggles now actually draw (they never did, see
below), splash screen and the PROSE ENGINE wordmark are in. The editor bar
sliding up under the card frame is fixed and reproduced both ways in a real
browser. Also: formatting bar, em dash, overused-words scan, manuscript-wide
search + highlight, and the rail player all built and committed 2026-08-13.

**The GitHub push has now spoken to github.com** — `editor-search-and-player`
pushed to `chefbennyj1/Prose-Studio` on 2026-08-15. That note is settled.

**The Gemini overuse judge is still unconfirmed, but the old note was wrong
about why.** It said "no key". The judge row is hidden whenever `critic.ai.ok`
is false, and Ben can see the row — so a key IS configured. What is unknown is
whether the judge has ever actually run, because it needs the toggle ON and
then a scan, and until 2026-08-16 the toggle drew no state at all. Nobody could
have known whether they had switched it on.

> **MANUSCRIPT REPOSITORIES ARE ALWAYS PRIVATE.** `private: true` in
> `GitHubService.createRepo` is the only value it will send and there is no
> parameter to change it. Do not add one. Publishing an unfinished novel is the
> worst thing this feature could do and it must not be one checkbox away.

## Weak adverbs, and why the count is not the feature, 2026-09-15

`AdverbLexicon` / `AdverbService`, `/api/proofing/adverbs`, a Review-menu row
and a drawer report. Whole story, local, exact, no model and **no Gemini half
at all** — unlike the overuse scan there is nothing here to opt into.

Ben asked for "a search and count for all weak adverb words". The count alone
would have been the wrong build. Every tool on the market reports "412 -ly
adverbs" and that number is close to meaningless — it is roughly a function of
how long the book is, and it teaches the writer to delete "slowly" from "walked
slowly", which leaves "walked". The adverb was the symptom.

So each hit is sorted into the edit it actually represents:

- **redundant** — "whispered quietly". The verb already contains the adverb, so
  it is a straight cut. The only one of the four where the edit is certain, and
  the only one coloured in the panel.
- **tag** — "said softly". The adverb is carrying what the dialogue should
  carry. Needs three things, not one: a speech verb, the adverb *outside* the
  quotation marks, and a quotation in that paragraph at all — the third is what
  keeps "he asked quietly whether she had eaten" out of the count.
- **propping** — "walked slowly". A generic verb held up by a modifier; the fix
  is a better verb. `said` is deliberately NOT in `WEAK_VERBS`: replacing "said"
  is bad advice, so an adverb on it is caught as a tag instead.
- **loose** — every other -ly adverb, reported as a rate rather than a list of
  sins.

Rows sort by how much of the word is CLASSIFIED, not by frequency. Count order
puts "finally" and "really" at the top of every manuscript ever written, which
is exactly the number nobody acts on.

### The names pass, which is why this cannot be per-chapter

Morphology cannot tell "Emily" from an adverb — it ends in -ly and no fixed list
can hold the cast of an unwritten novel. A capital does not settle it either,
because "Slowly, he turned" opens a sentence in the same shape.

Two rules, both biased toward calling a word a name, because a missed adverb
costs one row in a list while a character counted as an adverb puts the
protagonist at the top of the report and discredits the whole panel:

- a capital **mid-sentence** is decisive, and settles the word for the whole book
- a word **always** capitalised and never once lower-case, twice or more, is a
  name too — the case the first rule misses entirely, a character who only ever
  opens sentences

This is why the scan reads the whole story rather than the open chapter: the
evidence for chapter one is in chapter nine. The panel PRINTS the list it
skipped, because that decision is a guess that can go wrong both ways and
printing it is what makes it checkable.

### Two bugs the driver caught before any UI existed

**The four-letter stem guard was pasted in from the wrong lesson.**
ThesaurusService keeps "a stem under four letters is damage, so return the
original" because a bad stem sent to Datamuse returns confident nonsense. Aimed
at a closed table it silently LOSES matches instead: "raced" strips to "rac",
the guard hands back "raced", and "raced quickly" stopped being redundant even
though "race" was sitting in the table. Replaced with candidate stems — offer
every form and let the table decide. A closed table cannot be poisoned by a
short candidate; nothing in it is under four letters.

**A wiring check that could not fail.** Looking for the literal string
`editor__verdict--redundant` in Editor.js proved nothing either way: the class
is interpolated as `editor__verdict--${kind.id}`, so the literal never appears
in the source whether the code is right or wrong. Replaced with a check that the
template is emitted AND that the ids the lexicon can produce are the ids the
stylesheet colours. Same trap as the `includes('ThesaurusService')` incident
below, and it came back in a different costume.

Driven three ways before the browser: the service directly, the controller
handlers with a fake `res` and the manuscript layer stubbed (400 / 404 / 200 /
filtered all correct), and the routes against a real server on port 3101 —
**401, not 404**, which is what distinguishes "registered behind auth" from "not
registered". The 404-vs-401 probe is worth keeping; it is what proved the
already-running instance on 3100 was serving stale code.

Still unverified: the panel in a browser. Ben's dev server was running old code
and was not restarted.

### The instance list, 2026-09-15 (same day, Ben's catch)

The first shape showed **three** samples per word as blockquotes and stopped
there. Ben asked why it did not link to the instances the way the search does,
and he was right — a word with thirty-four uses showed three of them and offered
no route to the other thirty-one. Three gaps, not one:

- three of N, with no way to the rest
- **no highlight** — the search marks every match on the page, this only selected
  the one you clicked
- the blockquote-plus-button sample was about three times the height of a search
  hit, so a list of thirty would have been unreadable even if it existed

Now each word carries a `<details>` whose hits wear `.editor__search-hit`, the
search's own row. Reusing it is not laziness about styling: it is the same
object, and a writer has already learned it in this panel.

**The list is filled on first open, not up front.** Three hundred distinct
adverbs carrying every occurrence is several thousand list items in one
innerHTML, on a panel whose job is to open instantly.

**`MAX_OCCURRENCES` went 40 → 100**, because these are now a list rather than
three examples, and forty of ninety with no route to the rest is the letdown the
list exists to prevent. Rows carry `truncated` and the panel says "Showing the
first N of M" — the count is exact and the list is not, and a row saying 90 that
lists 100 badly is indistinguishable from a miscount.

**Occurrences gained `contextOffset` and `length`** so `markQuote` can be reused.
Searching the context for the word instead would mark the wrong one in
"carefully at the lock, then more carefully at the door" — the same trap
markQuote was written for. The offset is computed AFTER the whitespace collapse:
a manuscript wraps mid-sentence, so a context spanning a line break is a
character shorter once the newline becomes a space, and an offset taken from the
raw text lands one place left. markQuote's guard would have caught that by
silently refusing to mark anything, which is a bug you find by squinting.
Verified against a scan — all occurrences mark, including the wrapped case and
the twice-in-one-sentence case.

The panel marks in the **accent, not the drawer's amber**, which falls out of
reusing the search row and is the right way round: clicking a hit also lights
the word up in the manuscript via `.cm-proseMatch`, and one hit in two colours
across panel and page reads as two features that happened to run at once. That
is the reasoning already written above `.editor__output .editor__search-text
mark`; it now applies here for the same reason.

### Known limits, none of them worth fixing yet

- One-token lookback, so "turned over reluctantly" reads as loose — the particle
  hides the verb.
- The highlight is whole-word and case-insensitive on the WORD, so opening the
  instances for "carefully" lights every "carefully" in the chapter rather than
  only the classified ones. That is deliberate — an adverb is judged against its
  neighbours — but it does mean the page shows more marks than the row counts.
- `fillerAdverbs` in `resources/writing-flags.json` (139 words, live underlines,
  off by default) now overlaps this. They answer different questions — underline
  this chapter vs count the book — but the overlap is real and is worth a look
  before either grows.

> **`SensoryService` and `SensoryLexicon` are fully built and wired to NOTHING.**
> No controller, no route, no UI, no reference anywhere outside the two files.
> Dated 2026-09-01. Either finish it or delete it; a service nobody can reach is
> a service nobody is maintaining.

## A thesaurus that is not a thesaurus, 2026-08-21

Datamuse. **No key, no account, no model** - the same class of tool as spelling
and the mechanics scan, and it works with the AI switched off. Review menu, or
`Ctrl+Shift+T` with the caret in a word.

Ben started at "similes", which would have to be AI, and the objection that
turned it round is his own from the overuse thread: **the worst thing a writer
can do is open a thesaurus and start picking impressive words.** A panel that
returns forty synonyms IS that machine. So the design is mostly refusals:

- **The sentence is shown above the list**, with the word marked in it. The
  question is "what belongs in THIS line", not "what else means this".
- **Twelve results, as chips, not a list.** A vertical list of twelve invites
  reading all twelve and picking the most impressive.
- **Rare words are shown but dimmed and dashed**, sorted last. A reader WILL
  notice "coruscate" and the writer should know that before choosing it.

### Four fixes, each from a real failure in the output

- **Three queries, not one.** `rel_syn` is precise but LEMMA-BASED: "walked"
  and "stuttered" return nothing at all, and "said" returns the ADJECTIVE sense
  (aforementioned, aforesaid). `ml` handles inflections but is noisy - it
  offered "base on balls" for "walked", the baseball sense. So `rel_syn(stem)`
  is used as a **quality filter over `ml`**: a word in both is a real synonym
  AND already in the right tense.
- **Inflections collapsed, keeping the writer's tense.** Datamuse returns
  stammer / stammered / stammering / stammeringly as four answers. They are one
  suggestion, and "stuttered" should offer **stammered** so it drops into the
  sentence without the tense needing fixing afterwards.
- **Function words dropped by FREQUENCY, not by a list.** "said" was answered
  with was, were, had. Anything above 500-per-million is grammar, not a word
  anyone chooses.
- **Stemmer guard.** "said" -> "sai" and "pass" -> "pas" were poisoning every
  lookup silently. A stem under four letters is damage, not a stem.

Still weak on "walked" - WordNet's synset for it is genuinely thin, and
irregulars (said -> say) are out of reach for a naive stemmer. No ranking fixes
a poor source.

### Offsets are captured at lookup and VERIFIED before replacing

`applySynonym` re-reads the span and refuses if the text has changed since the
lookup. Without it, looking a word up, typing elsewhere, then clicking a
synonym replaces whatever now occupies those offsets - silently, in the wrong
place. Same rule `applySuggestion` keeps for the model's edits.

Case is the writer's, not the dictionary's: a word that opened a sentence still
opens it after the swap.

### The context menu that was not built

Right-click "Thesaurus > ..." was the obvious shape, and it was dropped for one
reason: **overriding `contextmenu` costs Chrome's spellcheck menu.** The editor
sets `spellcheck: 'true'` deliberately - the browser's checker is the free first
tier - and JavaScript cannot read those suggestions, so a custom menu cannot
offer them either. Mimicking search costs nothing and loses nothing.

> **TWO BUGS BEHIND ONE ERROR, AND A CHECK THAT PROVED NOTHING.**
>
> The handler was written in NarratorController's shape and pasted into
> ProofingController, which has no `fail()` - it repeats those three lines
> inline six times. `ReferenceError: fail is not defined` reached the browser as
> an HTML error page, which reads exactly like a missing route.
>
> Behind it sat a second: the `require` for ThesaurusService had never been
> added. **I had "verified" it with `includes('ThesaurusService')`, which was
> true because the pasted handler body mentions it.** A check that cannot fail
> is worse than no check - it converts an unknown into a false certainty.
>
> Driving the handler directly - a fake `res` object, no server, no browser -
> found both in one run. Do that before touching the UI.

`ProofingController` now has a `fail()` of its own and the six repetitions are
five calls to it. Three catch blocks deliberately keep their own shape: the
overuse judgement returns `ok: true` with the counts intact, the mechanics pass
inside spell only logs, and the suggestion scan answers over `deliver`.

## A second narrator, for the finished take, 2026-08-17

Piper writes; Gemini performs. **Piper does not move** — it is local, free,
instant and unlimited, which is what listening to a chapter you are still
rewriting needs. It is also unavoidably flat. The Gemini TTS models take
DIRECTION in plain English, which is the thing Ben actually needed:

> "Read aloud in a warm tone. book narrator. dramatic. noir, cyberpunk,
> English accent, not drawn out."

Voice: **Zephyr**. That prompt is his and it is doing real work — "not drawn
out" is what stops the noir register sliding into audiobook parody.

### Cloud TTS is not reachable from this app. At all.

The obvious-looking door — `console.cloud.google.com/.../media/speech`,
`texttospeech.googleapis.com` — returns:

```
401: API keys are not supported by this API.
     Expected OAuth2 access token or other authentication credentials.
```

That is not a restriction to loosen or an API to enable; Cloud TTS wants a
service account. **Do not spend another hour on it.** It is also the product
that bills a card rather than throwing, so being locked out of it is the safe
side of the door to be on.

What works is the Generative Language API — the same endpoint and the same key
as Critique — where six audio-capable models were visible to Ben's key:
`gemini-3.1-flash-tts-preview` (used, also offers `batchGenerateContent`),
`gemini-2.5-pro-preview-tts`, `gemini-2.5-flash-preview-tts`, and three
native-audio bidi models.

**Every one is a PREVIEW model.** The model id is configuration, not a
constant, so a withdrawal is a settings change rather than a code change.

### Measured, not estimated

338 characters -> 26.4s of audio, 939 tokens. About **2,800 tokens per 1,000
characters**; a 500k-character novel is ~1.4M tokens and ~10.8 hours of audio.

The models return **headerless PCM** (`audio/l16; rate=24000; channels=1`).
Nothing plays it until 44 bytes of WAV header go on the front. Int16 is divided
by **32768, not 32767** — the negative extreme is -32768 and 32767 puts it past
-1.0, which the wav writer clamps and a listener hears as a tick.

### The real constraint is requests per day, not money

Free tier meters *requests*, and a chapter is 200-odd paragraphs. So a full
chapter render WILL stop partway — and that is designed for rather than treated
as a failure. `ExportService` stops politely on a 429, keeps every rendered
paragraph, writes what it has, and reports how many are left with the reset
message. Tomorrow's run skips the done ones by hash. **A chapter over three
days, free, instead of a bill.**

### Why export/ is a separate folder from .audio/

`ChapterAudioService.#sweep` deletes any file its current manifest does not
reference. Two engines in one folder would therefore delete each other's work
on every render. Two products, two folders, no collision — and Piper's player
is untouched.

```
<story>/export/chapter_01/
    chapter.wav      the whole chapter, gaps included
    timestamps.txt   YouTube chapter markers, free from the manifest
    manifest.json    engine, model, voice, style, tokens
    parts/           one wav per paragraph, hash-named
```

`export/` is NOT hidden, unlike `.audio` — it is the thing being made and has
to be findable in Explorer. Folders are zero-padded: a file manager sorts
`chapter_10` before `chapter_2`.

**The style prompt is in the segment hash.** It changes the performance
completely while leaving the words alone, so a hash without it would serve
yesterday's reading of a paragraph just re-directed, with nothing on screen
saying why. Same failure shape as the flags config being dropped by `setValue`.

Gaps are inserted at STITCH time, not baked into the parts, so re-pacing a
chapter costs seconds instead of money.

### The button

**Narrator menu → Export narration**, below the transport, `data-needs-ai` so
it is absent entirely with the AI off. Routes:
`GET /api/narrator/export/plan`, `POST /api/narrator/export/render`.

It is the only control in the app that spends money, so it behaves unlike every
other button in the rail:

- **It asks first, with a real number**, and the number counts only what is not
  already rendered. Re-exporting after a typo fix quotes one paragraph, not the
  whole chapter — quoting the chapter again would frighten a writer off a
  render that costs nothing.
- **The confirmation names the folder.** "Where did it go" is the next
  question, and the answer is not beside the chapter.
- **Quota is reported as progress, not failure**: what is kept, how many are
  left, and press again tomorrow. Calling it an error would be a lie that costs
  the writer their nerve.

The row's hint carries the cost at rest (`8 para, ~6k chars`), rounded to the
nearest thousand characters, because a precise figure there reads as a bill.

Progress arrives on `export:progress` over the socket rather than the response,
which only settles at the end. The writer can close the menu.

> **`chapterOpened` does not exist.** I wired the button to it from memory and
> checked before testing; the editor dispatches **`manuscriptOpened`**, which
> is what `BackupButton`, `RailMenu` and the dictionary all listen for. Had it
> shipped, the button would have sat there permanently disabled with no story
> and no error — the flags bug again, in a different costume.

### Still not done

The style prompt has no editor. It lives in localStorage under
`prose-engine-export-style`, defaulting to Ben's noir line, and
`setExportStyle()` is exported and unused. It belongs in a submenu beside the
voice picker, since it is the direction the performance is acted to and it is
part of the segment hash.

`batchGenerateContent` is untested. If the batch quota is more generous than
the interactive one, a chapter could go as one job instead of 200 requests —
worth probing before building any UI around the trickle assumption.

`scratchpad/export-test.js` — 20 assertions, all passing, including two real
Gemini renders, the zero-cost second pass, and a stubbed quota stop.

## Writing flags: live underlines, no model, 2026-08-16

Ben supplied a TypeScript word list (the Matt Might "shell scripts to improve
your writing" lineage plus an AI-tells corpus). It is now
`resources/writing-flags.json`, 85KB, and the editor underlines what it finds
as the chapter is written.

`resources/` rather than `dictionaries/` for one reason only: the browser has
to fetch it, and `dictionaries/` is not a mounted static path. The converter
lives in the scratchpad — it transforms and EXECUTES the TypeScript rather than
retyping it, so the JSON cannot drift from the source. All 12 regexes are
compile-checked on the way out.

### The list contains two things that must never be highlighted

- **`irregularVerbs` is not a word list.** It is the second half of a
  passive-voice pattern: an auxiliary, then optionally an adverb, then a past
  participle. On its own it is said, thought, made, found, held, left, put,
  run, read, set, told, kept, heard — **most of the verbs a novel is built
  from.** Highlighting the list alone would underline half of every page. It is
  stored as `match: "composed"` with the auxiliaries beside it, and there is a
  test whose only job is to fail if this regresses.
- **`abbreviations` is sentence-boundary support**, not a flag list — the full
  stops that do not end a sentence. Stored under `support`, `highlight: false`.

The JSON is self-describing (`match`, `highlight`) precisely so the next person
cannot make either mistake by reading the data alone.

### One alternation per category, not nine hundred regexes

~900 literal terms over a 100,000-character chapter, on every change, is
90 million comparisons and a janky editor. One alternation per category is
eight passes, and the matching happens in the engine rather than a JS loop.
Measured: **4.3ms for a 5,500-word chapter, 16.8ms for 22,000 words.**

Terms are sorted LONGEST FIRST inside each alternation — JS alternation is
first-match-wins, not longest-wins, so "realm" ahead of "in the realm of" would
match the fragment and lose the phrase. Overlaps ACROSS categories are then
resolved the same way: one span, one flag.

Word boundaries are the Unicode lookarounds, not `\b`, for the same reason the
manuscript search uses them. Phrase whitespace becomes `\s+` so a phrase broken
across a line still matches, and apostrophes match both straight and curly
because the editor turns one into the other as you type.

### Where the scanning happens

In a CodeMirror view plugin, over `view.visibleRanges` only — built exactly
like the search highlight and for the same reason. **Nothing has to call it as
the writer types.** Offsets pushed in from Editor.js would need remapping
through every edit and would be wrong for as long as it took to recompute.

### Not every family is on by default, and that is the design

Everything switched on flags roughly **one word in nine** of ordinary prose. A
page with that many underlines is one a writer stops reading: the marks stop
meaning "look here" and start meaning "ignore me", which is worse than nothing,
because the real ones are camouflaged too.

On: `weasel`, `hedging`, `passiveVoice`, `aiPhrases`, `aiPatterns`.
Off, switchable: `fillerAdverbs` (139 adverbs, several of them ordinary
narrative words), `nominalizations` (written for technical prose — a novel
contains almost no "utilization"), `aiVocabulary` (contains "landscape",
"profound", "stark", "poignant" — words a novelist may have chosen on purpose).

The rail's **Review → Writing flags** submenu owns this. The master switch
("Underline as I write") is the FIRST row, above the families and separated
from them: unlike every other row in the Review menu this is not a check you
run, it is already running on every keystroke, so "make it stop" has to be one
click rather than eight. Off means all families off; on restores the DEFAULTS
rather than the last set used — someone switching this back on a week later
wants the thing that works, not a selection they no longer remember making.

The menu announces `writingFlagsChanged` and Editor.js listens, for the same
reason `runReview` is an event: the rail is permanent and the editor section is
rebuilt on navigation, so the menu cannot hold a reference to the editor.

The families are named in `ReviewMenu.js` rather than read from the JSON,
because the menu must draw before — and regardless of whether — that 85KB file
loads. A writer hunting for the off switch during a slow load still finds it.

### Known overlap, not yet resolved

**22 of the 95 weasel words are already in `OveruseLexicon`** — very, just,
really, quite, actually, literally, simply, almost, certainly, definitely and
others. Today they do not collide visually (one is a live underline, the other
an on-demand report), but two features now have opinions about the same word.

### Underlines, not washes

The search highlight can afford a background because it is asked for and turned
off again. These are on while the prose is being written. Wavy, like a
spellchecker, because that is the one convention every writer already knows.
Colour AND dash pattern differ per family — colour alone is no use to a
colour-blind writer, and there are eight families.

`unit_tests/test_writing_flags.mjs` — 10 assertions, all passing.

### setValue threw the configuration away, and the harness could not see it

Shipped, screenshotted, and **completely dead in the real app.** Ben opened it
and no text was highlighted anywhere.

`Surface.setValue()` without `keepHistory` calls `view.setState()`, which builds
a whole new state — so **every StateField goes back to its `create()` value**.
The writing-flags configuration lives in one of those fields. The editor loads
every chapter through `setValue`, so the config was wiped before there was any
prose to mark, every single time. `setValue` now carries it across explicitly.

> **The harness passed the text in at construction. The app never does.**
>
> `createSurface(host, { text })` and then `setWritingFlags(...)` is not the
> order the editor runs in — it creates an empty surface and loads chapters
> through `setValue` afterwards. My harness tested a sequence the application
> cannot perform, so it proved the scanner, the decorations and the CSS all
> worked while the feature was 100% broken end to end.
>
> This is the third time in this file that a harness has agreed with a broken
> build (see the unbalanced-HTML note, and the scroll lock that could not fail).
> **A harness must reproduce the caller's ORDER OF OPERATIONS, not just its
> inputs.** When the setup line differs from the app's, that difference is the
> bug you are not testing for.

`highlightState` has the identical exposure — a search highlight is also lost on
chapter load. That one is masked because `jumpToHit` re-applies the highlight
after opening a chapter, so it looks deliberate. Left alone rather than
"fixed" silently, since changing it changes search behaviour.

## An API key was acting as consent, 2026-08-16

`GeminiClient.availability()` read:

```js
if (!enabled && !process.env.GEMINI_API_KEY) return { ok: false, ... }
```

`enabled` is the Settings checkbox. `||` semantics mean **a key in the
environment satisfied the gate on its own** — so on any machine with
`GEMINI_API_KEY` set, which includes Ben's, switching the AI OFF in Settings did
not switch it off. The checkbox was decorative and the class header described a
promise the code did not keep.

**A key is not consent.** Supplying one says "here is how to reach Gemini if I
ask you to". Only the checkbox says "send my novel". `availability()` now reads
the checkbox and nothing else; `getApiKey()` still falls back to the
environment, because WHERE the key comes from is a different question from
WHETHER to use it.

It now fails CLOSED when settings cannot be read, which is the opposite of what
`ReviewMenu.drawAiRows` does on a failed request — deliberately, and the comment
in each says so. In the menu an unreachable server would hide half the Review
menu with nothing to explain it, so it fails open and lets the feature report
its own error. Here the question is whether the writer agreed to send their
manuscript to Google, and an unreadable answer to that is not a yes.

The whole UI chain follows from this one function: `data-needs-ai` rows (Line
edits, Critique, the lens submenu, the overuse judge) are hidden by
`drawAiRows` off `critic.ai.ok`, which comes from here.

> **Consequence for anyone running this: ticking the box in Settings is now
> required.** An env key alone will leave the AI rows hidden, correctly.

### What the disclosure says, and why it is per-feature

Settings now carries a "What gets sent to Google" block ABOVE the checkbox — a
disclosure underneath the control it qualifies is read after the decision. It
is specific per feature because the honest answer is not the same for all
three:

- **Critique** — the whole chapter (`GeminiCriticService.analyze`).
- **Line edits** — the whole chapter (`SuggestionService.suggest`; it is hunting
  cross-paragraph repetition, which a chapter cut into pieces cannot show).
- **Overused words** — counts plus at most six example sentences per word. Not
  the manuscript.

Rolling that into "some data may be shared" would be true and useless.

### Verifying it

`gate-test.js` stubs `models/GlobalSettings` through the require cache, so it
needs no Mongo, and runs **every case with `GEMINI_API_KEY` set** — that is the
only way to tell whether the checkbox is read at all. Five cases plus a check
that `getModel()` itself refuses. Against the old code: **4 of 6 fail.** Against
the new: all pass.

## Every toggle in the Review menu was invisible, 2026-08-16

`.rail-menu__switch` is emitted by three row builders in `ReviewMenu.js` — the
mechanics rules, the overuse word families, and the Gemini row — and **was
styled nowhere**. An empty inline span with no width. The rows toggled, the
`aria-checked` was maintained correctly for screen readers, and on screen there
was no difference between on and off in any of them.

So every setting in that menu has been operated blind since it shipped. Ben
found it by asking whether they were checkboxes.

> **This is what an invisible dependency between a builder and a stylesheet
> looks like.** The markup was right, the state was right, the accessibility was
> right, and the feature was unusable. Nothing in a DOM assertion would have
> caught it — `aria-checked` was always correct. It needed a rendered pixel or a
> person.

Now a checkbox: 16px, `var(--accent)` fill and a drawn tick when checked, glass
border and translucent fill when not. State selector is
`.rail-menu__toggle[aria-checked="true"]`, so the tick cannot disagree with what
is announced — one source of truth, not two.

**A checkbox rather than a sliding switch, and that answers the "all on"
question.** These rows say whether a family is included in the scan, and a
column of ticks reads as a set at a glance. All-on is now something you can SEE,
so the menu does not need an "All" button to get back to it. A switch would read
as a row of independent settings and have to be counted.

The tick is two borders of a rotated box rather than an `ion-icon`, because the
flyout is built and shown in one frame and an icon that resolves afterwards
would pop in under the cursor.

### "Ask Gemini which are tics" was the verdict value wearing a label

`tic` / `watch` / `fine` are `GeminiOveruseService`'s internal verdicts. Putting
`tic` on the button leaked that, and it pointed at the wrong thing: beside a
manuscript full of characters, a "tic" reads as something a CHARACTER does. What
the judge actually asks is whether the AUTHOR is reaching for a word by reflex.

Ben read it the character way, and he wrote the app. Now: **"Ask Gemini which
ones are worth fixing"** — what the AI adds to a list of counts the writer can
already see is an opinion on which ones deserve their time.

## The splash, and the name on the door, 2026-08-15

Ben's logo is in `resources/logo.jpg` (2816x1536, 1.6MB). What ships is
`views/public/images/prose-engine-logo.webp` — trimmed to the artwork, resized
to 900px, **31KB**. The splash is the first paint on a refresh, so the asset it
waits for has to be small; the full JPEG is fifty times the weight for a picture
displayed at 440px. `resources/` keeps the master. Regenerate with `sharp`:
`.trim({threshold:10}).resize({width:900}).webp({quality:88})`.

No cutout was needed. The wordmark is drawn on white, and `index.ejs` forces
`data-theme="light"` on boot, so the splash is white. **If the dashboard ever
gets a dark theme, this needs a logo with a transparent field** — not a dark
background behind a white rectangle.

### Why it is inline in index.ejs and not in loader.css

`loader.css` has a `#loading-page` block that looks like it is for exactly this.
It is unused, and it cannot do the job: `dashboard.css` (which imports it) is
fetched by `loadCSS()` during boot, so anything styled from there paints AFTER
the wait it is meant to cover. Its `z-index: 99` also sits under the topbar's
1000. The splash's CSS is inline in the head via `extraStyles`, which is
synchronous. A comment in `loader.css` now says so.

### Three rules for taking it down

1. **Not before 600ms.** On a warm cache the boot beats the eye, and a logo that
   appears and vanishes reads as a fault.
2. **Whatever happens.** It comes down in a `finally`, so a boot that throws
   leaves a usable page and an error in the console, not a white screen.
3. **Even if nothing happens.** A hung await never reaches the `finally`, so a
   12s timer removes it independently. *A splash is a cover for a wait; it must
   not become the thing being waited on.*

`transitionend` does not fire under `prefers-reduced-motion`, where the
transition is `none` — so the 700ms timer IS the removal there, not a backstop.

Verified by rendering the real EJS and serving it with no backend at all: boot
fails outright and the splash still clears.

### PROSE ENGINE, in two weights

`SEQUENTIAL` in the topbar is now `Prose` + `<span class="logo__thin">Engine</span>`,
matching the wordmark under the logo: 700 against 300, which is enough contrast
to read as one name rather than two words. `.logo` already sets 700, uppercase
and 2px tracking, and both halves share them.

> **Two words wrap where one could not.** As a flex item beside the tabs the
> logo shrank to its longest word and broke the name over two lines. `SEQUENTIAL`
> had no space in it, so nothing in `.topbar .logo` ever had to say
> `white-space: nowrap` — the rule was missing all along and only a rename could
> expose it. Caught in a screenshot, not in a measurement; the numbers all said
> 700/300/2px and were all correct.

The `<title>` fallback in `head.ejs` was `Sequential` and is now `Prose Engine`.

## The editor was never a full-height section, 2026-08-14

**The bar slid up under the top of the card when the caret reached the last
line.** Reported by Ben, and this time reproduced: at 1366x768 the bar moves up
20px, at 1280x720 it moves 34px, and `#main-content.scrollTop` is left holding
exactly that number. At 1920x1080 it does not happen at all, which is why it
reads as intermittent — the taller the window, the longer it hides.

### One missing selector

`layout.css` has a list of sections that get the full-height treatment when
active: `display: flex`, `margin: 0`, `height: 100%`, `padding: 0`. **The editor
was not in it.** Studio, Scene Editor, Layout Editor, Page Builder, Style Lab,
Story Critic, Exporter, Characters and Settings all were.

So the editor alone kept `.dashboard-section`'s defaults and
`.dashboard-section.is-active { display: block !important }`. That `!important`
beat `.editor { display: flex; flex-direction: column }` in `Editor.css`, and
everything downstream followed:

- `.editor__body { flex: 1 }` means nothing inside a block parent, so the body
  was sized by its CONTENT rather than by what was left under the bar.
- The content came out taller than the card — measured at every viewport, the
  writing page's bottom edge sat 9px to 85px BELOW the card's.
- That excess escapes into `#main-content`, which is `overflow: hidden` and so
  shows no scrollbar but can still be scrolled programmatically.
- The browser revealing the caret on the last line scrolled it, and there is no
  scrollbar anywhere to pull it back.

### Why the earlier fix did not cover this

`keepingOuterScroll` in `Surface.js` (2026-08-13) pins outer scroll positions
around the jumps the editor initiates — Apply, a search hit, an overuse finding.
An arrow-key press is not one of those. The caret reveal on a keystroke is the
browser's, inside CodeMirror, and never passes through our API. **That fix is
still right for what it covers; it was treating a symptom of this.** With the
column restored there is nothing above `.cm-scroller` left to scroll, which is
the structural version of the same protection.

### The 65vh cap is gone

`.editor__page` carried `max-height: 65vh`. It was a splint: with no flex column
the box had no height to inherit and would have grown to the length of the
chapter. It also meant `.cm-editor { height: 100% }` could not resolve, so the
PAGE scrolled and `.cm-scroller` never did — the opposite of what the comment
above it describes. Both are right now.

### What it changes visually

The card is full-bleed: no 4% margin, no 40px padding, the bar's border running
edge to edge like a header. That is how every other studio section already
looks.

> **The lesson, and it is the same one the rail player taught.** Do not chase
> the thing doing the scrolling — take away the ability to scroll. Ancestors
> cannot slide a bar out of view if none of them has anything to overflow.

### Verifying it

Real CodeMirror, real CSS, real key presses, four viewports: click into the
prose, 40x ArrowDown, Ctrl+End, 10 more. Assert the bar's `top` has not moved
and no ancestor of `.cm-scroller` has a non-zero `scrollTop`. **Run it against
the CSS with the fix stashed as well** — the earlier attempt at this bug shipped
on a harness that could not have failed. This one fails 2 of 4 without the fix
and passes 4 of 4 with it. Serve the project over HTTP; `Surface.js` imports
`/libs/codemirror/codemirror.js` and a `file://` page cannot resolve it.

## The player lives in the rail, 2026-08-13

**Uncommitted.** 7/7 against the REAL rail markup: height and width fixed at
108x300 through every status state including the progress bar toggling, and
`0.00px` movement on all four controls.

It is the first block in the Narrator menu, above the settings, because it is
the only part anyone opens that menu repeatedly for.

### Three homes in one day, and why the last one is right

Floating bottom-right -> a footer of the editor card -> the rail. Ben's call,
overruling the note that said a transport must not live in a dropdown. That
objection was real — pausing is something you do WHILE listening, and a menu
that closes on click costs two clicks every time — and it is paid for by one
line in `RailMenu.js` that stops a click inside `.rail-menu__transport` from
reaching the document handler. **If that line goes, this is the wrong home.**

### THE BUG, AND THE FIX THAT FINALLY WORKED

The player resized as its status text changed, and the buttons moved out from
under the cursor mid-skip. Pressing Next four times moved the control four
times and put Render where Next had been.

It took three attempts, and only the third is structural:

1. Pin the width. Fixed the horizontal, left the vertical.
2. Pin the width, give the status a `min-height`. **A floor, not a ceiling** —
   the progress bar appearing during a render still grew the block.
3. **Ben's: give the player a standard height.** `height: 108px` on the block,
   `flex: 1 1 auto; min-height: 0; overflow: hidden` on the status. Now nothing
   inside can change its size: not a longer line, not a wrapped one, not the
   progress bar, not a control someone adds in two years.

> The lesson generalises. Do not keep finding the things that resize a box a
> user clicks repeatedly — **stop the box being able to resize.** Every fix that
> enumerates causes leaves the next cause unhandled.

Within that fixed box the same layout rule still applies: playback pinned left,
Render pinned right, `.rail-menu__transport-gap` taking the slack between them.
Render is far from the skip buttons because it is work, not listening, and a
mis-click while scrubbing must not start minutes of synthesis.

`#narratorPlayBtn` is a fixed `width: 10ch`, not a `min-width`: the label swaps
Listen/Pause and at `min-width` the longer label won, so the button shrank by
**1.66px** on the swap and moved Next. Measured, not guessed.

### The trap this move created

`setUpNarrator()` binds its click listeners on every `initEditor`. That was safe
while the buttons lived in `editor.html`, which is re-injected on every
navigation — fresh elements, fresh listeners. **The rail is built once and never
torn down**, so the second visit to the editor would have left the first visit's
listener attached and Next would skip two paragraphs, then three. Guarded by
`narratorWired`, exactly as `reviewWired` guards `runReview`.

### Verifying it

`Editor.css` no longer styles the transport at all; it is `RailMenu.css`. A
harness must load `dashboard.html` and add `rail-menu--open`, not
`editor.html`.

> **A BROWSER HARNESS CANNOT CATCH UNBALANCED HTML. CHECK THE TAGS.**
>
> Moving the player out of `.editor__body` left it with no closing `</div>` —
> one tag too many removed while splicing. In the app the card's flex chain
> collapsed and the player did not appear at all.
>
> Every Puppeteer harness passed anyway, before AND after the fix, with
> identical numbers at five viewport heights. Browsers repair broken markup and
> `innerHTML` repairs it the same way, so the harness silently rebuilt a working
> tree from source that was wrong — the one arrangement where "verify paint"
> proves nothing, because the paint is of a DOM the browser invented.
>
> A twenty-line tag-balance walk over the SOURCE found it immediately. Any time
> markup is spliced programmatically, check balance before trusting a rendered
> result.

Two more, cheaper:

- The transport ships `disabled`. Chrome gives a disabled button no pointer
  events, so `elementFromPoint` returns its PARENT and a paint check fails on a
  button that is fine. Enable them in a layout harness.
- Waiting a fixed 350ms for ionicons made a suite flaky at roughly one run in
  three. Poll for `shadowRoot.childElementCount > 0` instead. A flaky layout
  test is worse than none — it teaches you to re-run until green.

## Manuscript-wide search, 2026-08-13

**Uncommitted.** 21/21 on the pattern builder, 7/7 on highlight paint in a real
browser, and 4/4 on client-vs-server agreement. **The panel itself has not been
driven in the running app** — the route needs a server restart, and nothing has
been clicked by hand.

`Ctrl+Shift+F`. CodeMirror's own `Ctrl+F` stays and is unrelated: that searches
the open chapter from memory, this searches every file in the story.

### Whole word is lookarounds, not a trailing space

Ben's first instinct was to append a space to the term. It fails twice, and the
test suite keeps both failures pinned because they are not obvious:

- It leaves the FRONT of the word unguarded — `"Rin "` still matches inside
  `"Mandarin "`.
- It loses hits followed by punctuation, which in dialogue is nearly all of
  them. On the test fixture a trailing space finds **zero of six**: a name at
  the end of a line is followed by `.` `,` `?` `!` or `\n`, never a space.

`\b` is also wrong here — it is defined on `[A-Za-z0-9_]`, and a manuscript is
full of invented names with accents. The pattern uses
`(?<![\p{L}\p{N}_])term(?![\p{L}\p{N}_])` with the `u` flag, which gets
`Renée` right (matches `Renée`, not `Renéed`).

**The query is plain text, always escaped.** A novelist should not have to
escape a full stop to search for `in.`.

### The highlight is computed live, and that is deliberate

`Surface.js` recomputes marks from the document rather than using the offsets
the server returned. Server offsets would agree with the panel for free — but
they describe the file as it was READ, so the moment the writer fixes one hit
the highlight would keep marking a word that is no longer there. A highlight
that lies about the text under it is worse than none.

The cost is a second copy of the pattern builder in the browser.
`Surface.searchPattern` **must mirror `SearchService.buildPattern`**; the
harness compares the two on identical text and fails if they ever drift.

- Only `view.visibleRanges` are decorated — this reruns on every keystroke
  while a highlight is live.
- Marks are **softer than a code editor's**: a wash plus an underline, not a
  solid block. Forty solid blocks down a page of prose measurably slow reading,
  which is what that surface is for.
- Cleared by Escape and by closing the drawer. The query is remembered, so
  reopening puts both results and marks back.
- **Re-applied AFTER `openChapter`, never before.** Loading a chapter rebuilds
  the editor state to drop the old undo history, which takes the highlight
  field's value with it.

### Traps

- `Ctrl+Shift+F` is on `document`, not in the CodeMirror keymap: the writer is
  usually IN the search box when they want it, and a keymap entry only fires
  when the surface has focus.
- Same cross-chapter jump trap as the overuse panel — an offset is valid in any
  chapter, so `jumpToHit` re-checks `doc.chapter` after `openChapter`, which
  refuses and returns when the buffer is dirty.
- Search reads FILES, so it saves first. Otherwise the open chapter is the one
  set of results that is stale.

### There is no replace, on purpose

A cross-chapter replace has no undo, writes to files that are not on screen,
and one careless term quietly corrupts a book — replacing `Rin` turns `during`
into `duMinag` in a chapter nobody is looking at. If it is ever wanted it needs
preview-every-hit-and-confirm, not a function added beside `search()`.

### esbuild moved to `dependencies` (2026-08-13)

`libs/codemirror/` is gitignored and `postinstall` builds it, so with esbuild as
a devDependency **any production install broke the editor entirely**:
`npm ci --omit=dev`, `--production`, or just `NODE_ENV=production` skips it,
postinstall fails, the bundle is never written, `Surface.js`'s import 404s and
the writing surface never appears. Do not move it back.

---

## Polish list — before shipping (Ben, 2026-08-13)

Small, agreed, not yet done. Kept here so they are not rediscovered later.

- **The "Library" button is still in the header and must go.** A leftover from
  the comic server; there is no library in the Prose Engine.
- `npm test` exits 1. Every verification written so far lives in gitignored
  scratchpad scripts and will evaporate — they should become the regression
  suite. Biggest single gap before shipping.
- The GitHub push has still never spoken to github.com from here, and the
  Gemini overuse judge has never run.
- Piper voice licences vary per voice on Hugging Face; check before shipping one.
- Most of this file below the handoff still describes the comic server.

---

## Overused words — intensifiers and absolutes, 2026-08-12

**Uncommitted.** 25/25 on hand-counted unit tests, plus end to end through the
controller against `NO OVERFLOW`: 88 uses of 22 words across 8 chapters /
9,854 words, **88/88 offsets landing on the reported word**. Routes answer 401
unauthenticated, same as the existing proofing routes. The Gemini half has
**never been run** — no key here — so `judge()` is unverified against the API.

### The split, which is the whole design

Ben asked whether the cloud AI could read the manuscript and list overused
words. It can, and it would be **wrong**, quietly: asked "how many times does
'very' appear" across a novel, a model estimates. It misses instances in long
text and invents counts it never saw, and nothing in the panel reveals which.

So counting and judging are separate services and fail independently:

- `OveruseService` counts. Regex over the real text, exhaustive by
  construction, instant, free, offline. Runs with the AI switched off.
- `GeminiOveruseService` judges, and is **never given the manuscript** — only
  the tally plus a few sample sentences. It answers the question counting
  cannot: of these 34, which are doing work? A wrong verdict is an opinion the
  writer can argue with, next to a number that is still correct.

`checkOveruse` catches a judgement failure and returns the tally with a note.
The counts are the part the writer acts on; a dead key must not cost them.

### Decisions with reasons (do not silently reverse)

- **Whole story, not the open chapter.** This is the one check that cannot work
  per-chapter — three "absolutely"s in a chapter is nothing and sixty across a
  novel is a habit, and the writer cannot see it because they never read the
  book the way a reader does.
- **Dialogue is counted but reported separately.** A character who talks in
  absolutes is characterised, not sloppy. One combined number tells a writer
  with a lot of dialogue they have a problem they do not have. Gemini is told
  the split and told to weigh dialogue leniently.
- **Ranked by rate, not count.** 34 is alarming in a short story and
  unremarkable in a 120,000-word novel, so everything carries `per10k`.
- **Nothing here is an error.** Every word in the lexicon is one a good writer
  uses deliberately. The scanner reports a rate and lets the writer look;
  "never use 'very'" is advice for undergraduates.
- **`so` and `too` are gated on the following word.** Both are conjunctions or
  "also" more often than intensifiers, and counting every one buries the real
  hits and makes the total untrustworthy — the one thing a counter must not be.
  See `CONTEXTUAL` / `NOT_INTENSIFIED` in `OveruseLexicon.js`.
- **Judging is off by default** and is the only control in the Review menu that
  sends anything off the machine. A check that quietly starts uploading because
  it was convenient is what the opt-in exists to prevent.

### Traps

- **Jumping is cross-chapter, which no other check in the panel is.** An offset
  is valid in *any* chapter, so applying one to whatever is open looks like a
  working jump to the wrong sentence. `renderOveruse` opens the chapter first
  and re-checks `doc.chapter` before selecting, because `openChapter` refuses
  when the buffer is dirty and returns either way.
- **`resolveStory` does not check the folder exists.** A renamed or deleted
  story lists zero chapters, which would have reported "nothing counted" — read
  as "my prose is clean". The controller now separates that from a genuinely
  empty story and 404s.
- **Occurrences are capped at 40 per word; counts are not.** Do not read
  `occurrences.length` as a count.

### Layout

```
services/proofing/OveruseLexicon.js   the word list, grouped, with the so/too gate
services/proofing/OveruseService.js   counting, offsets, rates, dialogue split
services/gemini/GeminiOveruseService.js  verdicts only - never sees the manuscript
controllers/ProofingController.js     checkOveruse, getOveruseWords
GET  /api/proofing/overuse/words      word and group list for the rail
POST /api/proofing/overuse            { story, options: { disabled }, judge }
```

### Left undone

- **The Gemini half is untested against the real API.** Verify `judge()` before
  trusting it, and check the verdict chip renders.
- The panel has not been seen in a browser at all — server path only.
- No way to add your own word to the list. That is the obvious next ask, and it
  belongs in the story dictionary rather than a new store.

---

## Editor formatting bar, 2026-08-12

**Uncommitted.** 31/31 in a Puppeteer harness driven against the running
server, so the stylesheets, the section markup and `Surface.js` are the real
files. Paint hit-tested with `elementFromPoint` on all six buttons.

Semantic Markdown only — bold, italic, strike, heading, quote, scene break —
plus the em dash, which is the one exception and earns it (below).
No font, size, colour or alignment, and that is a decision: the file on disk is
Markdown, which is what Git diffs, what `MechanicsService` anchors findings into
by character offset, and what the narrator reads. How the page LOOKS while
writing belongs in an appearance setting that changes the view and never the
file. The bar exists because nobody knows Markdown — a novelist wanting italics
will not guess `*like this*`.

### The traps

- **`mousedown`, not `click`.** A click steals focus from CodeMirror first,
  which collapses the selection, so Bold arrives with nothing to wrap.
  `preventDefault` on mousedown keeps the caret where it was.
- **Italic must not eat bold.** Italic's marker is one asterisk and bold's is
  two, so a naive match strips one from each side and silently demotes
  `**bold**` to `*italic*` — a formatting change the writer never asked for.
  `toggleWrap` checks whether the marker is part of a longer run.
- **A scene break needs a blank line on BOTH sides.** The first version wrote
  `\n***\n\n`, giving no blank line above it — and `***` on the line straight
  after a paragraph is not a scene break to any Markdown parser, it is more of
  that paragraph. The break vanished from anything that rendered the file.
  Both blanks are now added only where they are not already there, or the gap
  grows every time the button is used.

### The em dash is not a formatting button (Ben, 2026-08-13)

It is in the bar for a different reason from everything beside it, and the
distinction is worth keeping straight if the set is ever revisited. The other
six exist because nobody knows Markdown. This one exists because of **hardware**:
a laptop has no numeric keypad, so the `Alt+0151` Windows documents for U+2014
cannot be pressed at all. The alternative is two hyphens and a
search-and-replace at the end of the book.

It uses `insertText`, not the toggle helpers - there is no "un-em-dash", it is
a character, and Undo already removes characters. It replaces the selection,
because that is what typing a character does.

The glyph is its own icon. No icon set draws an em dash better than the
character does, and showing the real mark is also showing exactly what will
land in the file. `--dash` sets it larger and nudges it up a pixel, because at
the letters' size a horizontal rule of a glyph reads as a stray mark.

**En dash and ellipsis are the same problem** (`Alt+0150`, `Alt+0133`) and were
deliberately not added unasked. If they ever are, they belong beside this one
in the same group, not scattered.

### Two things the harness got wrong before the code did

Worth knowing, because both would fool the next harness too:

- **`.editor__page` is `margin: 0 auto` in a flex column**, so auto margins
  suppress the stretch and the width is shrink-to-fit. A short test string
  collapsed the page to 188px and produced a bogus alignment failure. Test
  text must be chapter-shaped or every horizontal measurement is a lie.
- **Box-to-box alignment tests cancel out.** `.cm-content`'s border edge is
  32px left of its first letter and the B button's is 7px left of its B, so
  comparing boxes passes within 8px whether the letters line up or not. Measure
  glyph to glyph. The bar's `padding-left` is `46 + 32 - 7 = 71px` for exactly
  this reason.

### Left undone

- Ben reported the top padding looking wrong in the real app. The bar now
  carries `16px` above and `4px` below (the prose already has `.cm-content`'s
  40px), which reads correctly in the harness — **not yet confirmed against
  the running app in a browser.**
- No `Mod-b`/`Mod-i` equivalent for strike, heading, quote or scene break.

### Backup, 2026-08-09/10

**ONE REPOSITORY PER STORY**, not one for the story root. The root is the
parent folder every story sits inside, so backing it up as a single repository
swept unrelated work in with the novel — Ben's first real run pushed a
benchmark story up alongside the manuscript. A novel is the unit a writer
thinks in, so it is the unit that gets a repo. Mappings live in
`github.repos[]`; a story with no mapping is simply not backed up, which is how
scratch stories stay out.

`isomorphic-git` (pure JS) so no git install is needed — which forces HTTPS and
a classic PAT rather than SSH. Classic, not fine-grained: fine-grained cannot
create repositories without Administration write across every repo.

Three traps, all found by asking "what if the writer already has a repo":

- **Never rewrite their remote.** The first version deleted `origin` and wrote
  its own HTTPS URL, which would silently break a writer's own SSH workflow.
  It now pushes to an explicit URL and leaves `origin` alone.
- **Never assume `main`.** An older repo is on `master`; pushing `main` would
  make a second branch beside their real history.
- **`.gitignore` does not untrack.** Audio already committed stays tracked, and
  the commit loop originally decided add-vs-remove by "is it on disk" — which
  re-added the very files `untrackAudio` had just removed. The action is now
  decided explicitly in `pendingFiles`.

Narration is `.audio/*.wav` **inside** the story folder — uncompressed, tens of
MB a chapter. Excluding it is step one, not a nicety.

> **THE LOCAL MODELS ARE GONE (Ben, 2026-08-09).** Do not reintroduce a local
> LLM, `services/plugins`, `PluginLoader`, or the editor-presence heartbeat.
> The old rule — "local-first AI is product identity, never propose swapping
> the local model for a cloud LLM" — was retired deliberately, not forgotten.
> `WORKING_PRACTICES.md` carries the rule that replaced it.
>
> **The AI is opt-in and that part is not negotiable.** Nothing reaches Google
> unless the writer switches AI on in Settings and supplies a key, and until
> they do, Critique and Line edits are not shown in the rail at all. Spelling,
> the mechanics scanner and the narrator stay local, instant and free — they
> are what make the opt-in honest.

---

## The local models and the plugin system are gone, 2026-08-09

**Uncommitted.** Verified: the API mounts, `/api/plugins/*` is 404,
`/api/proofing/status` reports the AI off with a readable reason, and the
mechanics scan still returns findings with the AI switched off.

### Why

The local Gemma 3 4B ran on an 8192-token context, so a chapter was cut into
9000-character pieces and each was judged blind to the rest — structural
critique of a fifth of a chapter. Every failure the editor had came from the
engine around it: a ~60s cold load, a two-minute wait for it, a presence
heartbeat that never fired for a plugin enabled after the tab opened, and a
port mismatch that sent every status poll to a dead port. Gemini takes the
chapter whole.

The floor under that decision is the mechanics scanner. Spelling plus 26
mechanics rules plus the narrator is a genuinely useful editor with the AI
switched off, which is what makes "opt-in" a real choice rather than a slogan.

### What went

`LocalCriticService`, `PluginLoader`, `PluginHooks`, the plugin-manager section
and its Plugins tab, the plugin routes, the presence heartbeat, the engine
picker in the rail, and `services/plugins` entirely — about 815 lines of
tracked code and ~500 more that was gitignored.

Both plugins went with it. **Proof-Reader was already dead**: it subscribed to
a `scene-saved` hook that nothing in the app had ever fired.

### What was built

- `services/gemini/GeminiClient.js` — one place that resolves the key and owns
  the opt-in gate. Everything AI asks it whether it may run.
- `SuggestionService` rewritten on Gemini's structured output. **`verify()`
  stayed.** It was written for how freely a 4B invents a quote, and Gemini
  paraphrases less often but not never; the cost of one slipping through is
  corrupted prose in a file the writer trusts.
- `CriticEngine` collapsed from an engine chooser to a passthrough.
- `[data-needs-ai]` rows in the rail, hidden until the AI is on.

---

## Mechanics scanner + the rail refactor, 2026-08-09

**Uncommitted.** Rules verified by `scratchpad/mech-test.js`: 25 faulty lines
each fire their expected rule, 18 correct lines fire nothing, every finding's
`quote` matches `text.substr(offset, length)` exactly. Layout verified by
screenshot against a harness built from the real markup and stylesheets.

### Why regex and not a model

The critic and SuggestionService already ask a model for judgment and both pay
for it — `SuggestionService.verify()` exists entirely to throw away suggestions
the model could not locate in the text it was given. Mechanical faults need an
exact span, the same answer every time, and an answer now. So `MechanicsService`
is hand-rolled rules: instant, free, offline, and its offsets are correct by
construction rather than by verification.

- `MechanicsText.js` — sentences, paragraphs, quoted-speech spans
- `MechanicsLexicon.js` — speech verbs, action verbs, finite verbs, a/an
- `MechanicsRules.js` — 26 rules across punctuation / dialogue / grammar / structure
- `MechanicsService.js` — runner; anchors and de-duplicates findings
- `POST /api/proofing/mechanics`, `GET /api/proofing/mechanics/rules`

### The traps this cost time on

- **A `]` inside a character class built by template literal ends the class.**
  The sentence-boundary pattern demanded a trailer that is almost never there,
  so the splitter found *no* boundaries at all and handed every rule one
  sentence per paragraph. It failed silently — 19 paragraphs, 19 "sentences" —
  and produced two false comma splices. `TRAILER_CLASS` is now pre-escaped.
- **Fiction breaks grammar on purpose.** Anything a good writer does
  deliberately is reported as `style`, never `error`, and the rail has a
  per-rule toggle so a voice built on fragments can switch that rule off rather
  than learn to ignore the panel. Rules that cannot be sure stay out entirely.
- **Guards are most of the work.** Comma-splice skips participial openers
  ("Tired, she waited"), subordinate clauses ("When the rain fell, he ran"),
  and parentheticals ("she looked at him, he thought, and left"). `he/she/it
  were` skips the subjunctive. Removing any of these brings false positives
  straight back.

### The rail

Every control left the editor's right panel: lens, engine, Spelling, Scan,
Critique are now the Review menu (`components/RailMenu/ReviewMenu.js`), which
dispatches `runReview`; the panel is an output-only drawer that opens on a
result and closes to give the width back. Narrator *settings* were already in
the rail, and **the transport joined them on 2026-08-13** — see "The player
lives in the rail" below. This section used to say the transport was
deliberately NOT in the rail, because a control inside a dropdown costs two
clicks; Ben overruled that. The cost is paid by `.rail-menu__transport` not
letting a click close the menu.
- `runReview` is bound to `document` and survives section teardown, so it is
  guarded by `reviewWired` — without that it ran every check twice on the
  second visit to the editor.

> **ELEVENLABS AND KOKORO ARE BOTH GONE (Ben, 2026-08-06).** ElevenLabs was
> cancelled on cost ("it would just cost too much for the writing process")
> before any synthesis was written. Kokoro was replaced by Piper on quality and
> speed. Do not reintroduce either. There is no cloud TTS in the Prose Engine
> and no API key to configure.

---

## Narrator — rebuilt on Piper, 2026-08-06

**Uncommitted.** Verified against the running app: 17/19 Puppeteer checks, the
two failures being harness bugs (a regex that lost its `\d` through shell
quoting, and a favicon 404 counted as a console error). The only failing
request anywhere in the flow is `/favicon.ico`, which predates this work.

### Why Piper, with numbers

Measured on Ben's machine, same paragraph, `scratchpad/bench.js`:

| Engine | Speed | Tail vs body peak |
|---|---|---|
| Piper `lessac-medium` | 10.1x realtime | 0.434 |
| Piper `ryan-high` | 2.2x | 0.786 |
| Kokoro `af_bella` (CPU) | 0.9x | 0.237 |

"Tail vs body peak" is the end-of-sentence fade as a number — peak of the last
500ms against the rest. Kokoro's 0.237 is the "narrator is dying" complaint.

Bark was considered and rejected on evidence, not taste: its ~13s ceiling makes
"a paragraph at a time" impossible (a normal paragraph is 25-50s of speech), and
it has no phoneme control at all, which would have made invented names worse.

### It runs pure Node — no Python, no GPL binary

Piper ships as a Python package wrapping a GPL-3.0 binary. Neither is used. A
Piper voice is a VITS ONNX model driven by espeak phoneme ids, and both halves
were already present as kokoro-js transitive deps. They are now declared
directly in `package.json` (`onnxruntime-node`, `phonemizer`) rather than
relied on by accident. Only the voice files are downloaded. Voice licences vary
per voice on Hugging Face — check before shipping one.

### The two traps this cost time on

- **Some voices silently truncate.** `en_US-ryan-high` returns 0.61 of a
  four-sentence paragraph — it drops ~40% of the prose and reports no error.
  `lessac-medium` returns 0.97. `PiperService` calibrates each voice on a short
  sentence at load, then checks every synthesis against that pace and re-renders
  sentence-by-sentence when one comes back short. **Do not remove that check**,
  and do not assume a voice is safe because one paragraph worked.
- **Respellings can make pronunciation worse.** `SY-liss` phonemizes to
  `ˌɛswˈaɪlˈɪs` — "ess-why-liss", because espeak reads `SY` as the letter S.
  The lexicon still holds respellings, but the pronunciation flyout now shows
  the real phonemes as you type, so the trap is visible instead of mysterious.

### Layout

```
services/narrator/
  TextPlan.js            markdown -> paragraphs + scene breaks (was views/.../prepare.js)
  PiperVoices.js         catalogue from HF, install/remove, ai_models/piper/
  PiperService.js        phonemize -> ids -> onnx, session cache, truncation guard
  ChapterAudioService.js paragraph render, content-hash cache, manifest, sweep
controllers/NarratorController.js
views/dashboard/components/Narrator/
  NarratorMenu.js  voice + pronunciation, in the rail
  Player.js        playlist playback of rendered segments
  voices.js        voice + speed preference
```

`TextPlan.js` moved out of `views/` because nothing in the browser imports it
any more — the server does all the text planning now. That also removed a
`{"type":"module"}` marker that had been needed to make Node parse it.

### Storage and staleness

`<storyRoot>/<Story>/.audio/<Chapter>/` holds one WAV per paragraph, named
after a sha1 of **voice + length scale + exact text**, plus `manifest.json`.
So editing one paragraph re-renders one paragraph, reordering renders nothing,
and switching voice re-renders everything. Files the manifest no longer
references are swept, so the folder cannot grow without bound. Verified: one
edited paragraph gave `1 rendered, 3 reused, 1 swept` with the folder size
unchanged.

WAV, not MP3, deliberately: an encoder would be a new dependency and a chapter
is ~50MB. If that becomes a problem, that is the one decision to revisit.

### Reading pace — the one to know

Piper's trained pace reads a novel at **~222 wpm**. Audiobook narration is
150-160; past ~190 it is heard as rushed, and it was, instantly. The default
`length_scale` is now **1.45** (~153 wpm), with a stepper and a preview button
in the Narrator menu. The scale is part of every segment hash, so changing it
re-renders by itself — no version bump needed.

### Music bed

Layered at PLAYBACK, never mixed into the rendered files. Mixing would put the
track inside the content hash: changing it would re-render the book, and
re-rendering one paragraph would drop the bed back at a different point in the
loop. Tracks live in `<storyRoot>/.music/` — hidden, shared across stories.
The writer drops files in and reopens the menu.

### Rail menus: three bugs worth remembering

- **`.glass` sets `overflow: hidden`**, and `#studioRail` inherited it, so every
  rail menu was laid out correctly and never painted. No z-index fixes a
  clipped child. Overridden on the rail, which is square and needs no clip.
- **A hover-reveal plus a click-toggle cancel out.** The old "Open" row revealed
  its flyout on mouseenter and the click that followed closed it, so Story and
  Chapter could not be opened by clicking at all. The row is gone; the list is
  inline in the menu.
- **Flyout placement is JS, not CSS** (`place()` in RailMenu.js). A voice list is
  as tall as the number of installed voices, so anchoring up or down is wrong on
  its own — the full catalogue started 265px above the top of the window.

**Verify PAINT, not layout.** `getBoundingClientRect().height > 0` passed the
whole time the menus were invisible. `scratchpad/paint.js` hit-tests three
corners with `elementFromPoint`; that is the assertion that catches this class
of bug.

### Menus re-read their folder on open

Music and voice lists refetch every time the menu opens, because both are
directory listings and files get added while the app is running. Story and
Chapter always did. Redraws after picking pass `false` — nothing on disk
changed, and a round trip would only make the tick lag.

### Dictionary — spelling and pronunciation merged

`DictionaryService` replaced the spelling word list and `PronunciationService`.
Two layers: **global** (the writer's habits — realise, grey) and **story** (this
book's invented names), story winning on conflict. An entry is `{ spoken }` with
spoken optional, so "this is a word" and "say it like this" are separate facts
on one row. `SpellService` and `ChapterAudioService` both read it.

**The bug this killed:** "add to dictionary" wrote under `currentSeriesFolder()`
— a comic-era key — while `runSpelling` sent **no key at all**, so
`readCustomWords('')` hit an early `return []`. The write went to a file the
read never opened, and a word added was reported unknown for ever. Mina and
Saito were sitting in `dictionaries/default.json` doing nothing. Migration folds
the old files in and renames the originals `.migrated`.

### Two data-integrity fixes

- **`selectStory` assigned `doc.story` before loading anything** and returned
  early when the buffer was dirty, leaving `doc` naming a chapter of the NEW
  story while the surface held the OLD one. The four-second autosave then POSTed
  one story's text into another story's chapter. Only the staleness check
  stopped it. `doc` is now touched only after a successful read.
- **`SAFE_SEGMENT` was an allowlist** that rejected
  `Chapter 1 (original pre-refactor)` — a real file, legal on every filesystem —
  while `listChapters` still offered it, which made NO OVERFLOW impossible to
  open. It is now stated as what is forbidden: Windows-illegal characters,
  control characters, leading dot, trailing dot or space, `..`, device names.
  Apostrophes and commas in chapter titles work now too.

### espeak spells out vowel-less clusters

`Hmph!` phonemizes to `ˌeɪtʃˌɛmpˌiːˈeɪtʃ` — "aitch-em-pee-aitch". Any letter
cluster with no vowel (hmph, pfft, shh, brr, tsk) is read as its letters,
because espeak has no rule that makes it a word. The fix is always a dictionary
entry pointing at a real spelling that has a vowel: `Hmph -> humph` (hˈʌmf), or
`harrumph` for the theatrical version. The manuscript keeps its own spelling.

The reverse trap is just as common: `ma'am` is ALREADY correct at `mˈæm`, and
every respelling reached for by instinct — maam, marm, mahm — gives `mˈɑːm`.
**Check the phoneme line before saving an entry.** A wrong respelling is worse
than none.

### Left undone

- **`Bench Story`** and **`Second Story`** in the story root are test fixtures.
  Safe to delete.
- **Multi-speaker voices are stuck on speaker 0.** `en_GB-vctk-medium` — the one
  Ben settled on — carries **109 speakers** (p239, p236, p264, …) and
  `PiperService` passes `sid: opts.speaker ?? 0`, so every render has been p239,
  chosen by accident. `speaker_id_map` in the voice config has all the names.
  A speaker picker is 108 more voices already on disk; it is the largest
  remaining win and it is nearly free.
- **The dictionary substitutes plain TEXT before phonemization**, so a word can
  only be respelled by letter and espeak has to agree. Piper is phoneme-driven,
  so an entry could instead carry IPA (`/mˈæm/`) spliced straight into the
  stream — the permanent answer to "I cannot find the phoneme".
- **Music volume is fixed at 0.12** with no control; `Player.setMusic` takes one.
- **The bed loops with `<audio loop>`**, which is not gapless in every browser.
  Web Audio would be, at the cost of real complexity.

---

---

## Handoff — 2026-08-05

Everything below is committed and pushed to `github.com/chefbennyj1/Prose-Studio`
(private). Working tree clean.

### THE DOCS BELOW THIS SECTION ARE STALE

Most of this file still describes the comic server. It lists controllers that
no longer exist (`ExportController`, `PageLayoutController`, `VisionController`,
`MediaController`, `StyleLabController`, `ViewerController`), omits the ones
that do (`ManuscriptController`, `ProofingController`, `SetupController`,
`StorageController`, `AccountsController`), documents a deleted
`Library/layouts/` tree, and claims `Character` has a `voiceId` — there is no
`voice` field anywhere in `models/`. **Verify against code before trusting any
of it.** Rewriting this file is the cheapest outstanding job.

### Environment traps that cost real time today

- **nodemon does NOT restart on `server.js` changes.** It ran ~11 hours with
  stale code. Two separate bugs were chased that were only "the server never
  reloaded". Restart manually and confirm the change is live before debugging.
- The dashboard shell (`dashboard.html`) is injected by `loadSection` and
  `glass_component.js` is appended dynamically — **both after
  `DOMContentLoaded`**. Anything in the kit that binds on that event
  (`GlassDropdown.init()`) never sees the rail. This is why the Story/Chapter
  menus own their own open state.
- Verify UI standalone with Puppeteer against the **real ancestor chain**
  (`.dashboard > .app-body > #main-content > .editor.dashboard-section`) and
  **with the section starting `.hidden`**. A harness that renders it visible
  passes while the app fails — CodeMirror measures zero inside `display: none`.

### Narrator (Kokoro 82M, browser-side)

Runs in a Web Worker, WebGPU/fp32 when available, else WASM/q8. Force one with
`localStorage.setItem('narrator_device', 'wasm')` — **this A/B has never been
run and is the top open question.**

Unsolved: the voice fades/degrades at the end of each utterance. Confirmed on
the raw model output via a separate playback path, so it is not the Web Audio
code. Mitigations in place, none confirmed effective: one sentence per
`generate()` (`SENTENCES_PER_CHUNK`), terminal punctuation forced on every
chunk (`terminate()`), tail trim in the worker. **If WASM is clean, it was GPU
kernel precision all along and the text-side fixes can be relaxed.**

Do not switch to Bark: autoregressive, ~13s hard limit per generation, and
drifts between chunks. Wrong shape for consistent long-form narration.

### Immediate next task (agreed, not started)

A **Narrator rail menu**, same pattern as Story/Chapter in `dashboard.html`:
- **Voice** — Bella (`af_bella`) / Michael (`am_michael`) as a flyout
- **Pronunciation** — the lexicon editor, with list and delete

Move both out of the editor: the voice `<select>` in `editor.html` and the
cramped `<details class="narrator__lexicon">` in the panel. They are settings,
not writing controls. The pronunciation feature itself works today — backend,
substitution and Test button are all done and verified.

### Other open threads

- **Chapter render to file** — the original plan: pipelined render to MP3 in a
  hidden `.audio/` per story, staleness via the `modified` mtime
  `ManuscriptService` already tracks, driven from Scheduled Tasks. Note that
  tab renames to "Scheduled Tasks" (`dashboard.html` still says "Scanner"
  while `data-page` already says `scheduled-tasks`), and that panel is still
  full of comic-era Vision AI controls.
- **Markdown preview** — Ben called it "a plus". `renderMarkdown` in
  `EditorRender.js` already exists; needs `*italic*` and `***` as a scene break.

### Decisions made, with reasons (do not silently reverse)

- **Line numbers count logical (`\n`) lines, not wrapped rows.** They match
  what `SpellService` reports, survive resizing, and Ben values them for
  judging how far to scroll. Visual rows would be finer-grained but do not
  exist in the file, so they cannot be quoted between Ben and an agent.
- The editor's measure is **67 characters** — measured, near the classical
  ideal of 66. Do not "fix" the 6.5in width.
- `.editor__page { max-height: 65vh }` is **Ben's** choice and it works. It was
  the definite height CodeMirror needed. Leave it.
- Pronunciation entries are **respellings** (`SY-liss`), not IPA — typable by
  ear, and engine-agnostic if the voice is ever swapped.

---

> **Read `WORKING_PRACTICES.md` before starting work.** It covers how to work
> here — house rules, verification discipline, and this environment's traps.
> This file covers what the code is; that one covers how not to break it.

# Sequential Comic Server — Agent Navigation Guide

A Node.js/Express platform for creating, reading, and publishing digital comics. MongoDB backend, EJS templates, Socket.io for real-time feedback, Puppeteer for print export, and Gemini AI for automated panel metadata.

> **Deep architecture docs:** See `GEMINI.md` (schema diagrams, export pipeline, vision hashing, viewer render flow).

---

## Quick Start

```bash
npm run dev          # nodemon server.js — auto-reloads on *.js/ejs/css changes
# MongoDB on localhost:27017, database ProseEngine (NOT VeilSite — that's the comic server)
# Server listens on port 3100; Socket.io shares the same HTTP server
```

### First run

The engine boots with or without a database. Until it has both a database and
one account, every route redirects to **`/setup`** and `/api/*` returns 503 —
there is no self-registration to fall back on, because `/accounts/request` only
files a request and every approval route sits behind `isAdmin`.

The wizard is two steps: give it a MongoDB connection string (it tests the
connection, creates the database and collections, and writes `MONGODB_URI` plus
any missing secrets to `.env`), then create the admin. Both steps refuse once
setup is complete, so the door closes behind you.

Locked out later — last admin's role clobbered, say? `node scripts/promote-admin.js <email>`.

**Env vars** (`.env`). Missing secrets are generated on first boot or by the wizard:
| Variable | Purpose |
|---|---|
| `MONGODB_URI` | Database connection. Absent ⇒ `mongodb://localhost:27017/ProseEngine` |
| `SESSION_SECRET` | Express session encryption |
| `INTERNAL_EXPORT_SECRET` | Puppeteer headless auth bypass |
| `GEMINI_API_KEY` | Google AI vision scanning |
| `ELEVEN_LABS_API_KEY` | TTS (optional, lightly used) |
| `USE_CLOUD_STORAGE` | `false` = local disk; `true` = GCS |

---

## Directory Map

```
server.js                        Entry point — middleware, routes, MongoDB, Socket.io
├── api/
│   ├── api.js                   All API route declarations (80+ endpoints)
│   └── scanLibrary.js           Filesystem → MongoDB sync orchestration
├── authentication/
│   └── authentication.js        Login/logout with bcrypt + rate limiting
├── middleware/
│   └── auth.js                  isAuth / isAuthApi / isModerator / isAdmin + export bypass
├── routes/
│   ├── routes.js                HTML page routes (EJS views)
│   └── content.js               Auth-gated static Library asset serving
├── models/
│   ├── User.js                  Accounts: role (basic/moderator/admin), email, password hash
│   ├── Series.js                Series metadata, styling config, custom CSS paths
│   ├── Volume.js                Volume → chapters[] → pages[] (embedded, denormalized cache)
│   ├── Character.js             Character profiles, avatars, reference images, voice IDs
│   ├── LibraryRoot.js           Registered filesystem scan roots
│   └── GlobalSettings.js        System-wide config document
├── controllers/                 Request handlers — thin, delegate to services
│   ├── AssetUploadController.js Upload + flip panel images (Multer)
│   ├── CharacterController.js   Character CRUD + avatar/reference uploads + Gemini analysis
│   ├── CriticController.js      Gemini story critique endpoint
│   ├── DashboardController.js   Dashboard view data
│   ├── ExportController.js      Puppeteer PDF/PNG export pipeline
│   ├── LibraryController.js     Series/volume/chapter browse metadata
│   ├── MediaController.js       Dynamic image serving + scene/media JSON
│   ├── PageDataController.js    Read/write page.json (scene cues + media mappings)
│   ├── PageLayoutController.js  List layouts, change layout, toggle spread, serve preview
│   ├── PageStructureController.js Create/insert/reorder pages and chapters
│   ├── ScheduledTaskController.js Library root management + manual scan trigger
│   ├── SiteController.js        Landing page, login page, library shell, font list
│   ├── StyleLabController.js    Per-series bubble/narrator style settings + custom CSS upload
│   ├── SystemSettingsController.js Global settings CRUD (admin only)
│   ├── UserController.js        Register + get/update user (admin)
│   ├── ViewerController.js      Viewer page data
│   └── VisionController.js      Start/stop Gemini panel scan job
├── services/                    Business logic — called by controllers
│   ├── AuthService.js           Auth helper utilities
│   ├── CharacterService.js      Character queries
│   ├── DownloadService.js       File download coordination
│   ├── HierarchyLookupService.js Resolve series/volume paths from DB
│   ├── LayoutService.js         Load layout HTML/CSS, panel management
│   ├── MediaService.js          Image asset path resolution
│   ├── PanelService.js          Panel metadata ops
│   ├── PreviewService.js        Generate preview images
│   ├── ScriptService.js         Screenplay/script handling
│   ├── UserService.js           User queries
│   ├── VolumeService.js         Core FS sync, page scaffolding, volume creation
│   ├── gemini/
│   │   ├── GeminiVisionService.js  Panel image → descriptions/alt/hashtags
│   │   └── GeminiCriticService.js  Volume script → story critique
│   └── public/                  Client-side scripts (served at /services/public/)
│       ├── PageManager.js       Sliding window preloader [prev, current, next]
│       ├── SceneManager.js      Render panels, masks, dialogue cues
│       ├── VolumeManager.js     Volume-level client state
│       ├── UserManager.js       Client-side auth state
│       └── CameraManager.js     Camera/pan effects
├── views/
│   ├── landing/index.ejs        Public landing page
│   ├── auth/index.ejs           Login form
│   ├── reader/
│   │   ├── browser/index.ejs    Library browser shell
│   │   ├── browser/series.ejs   Series volumes page
│   │   ├── browser/volume.ejs   Volume chapters page
│   │   └── viewer/index.ejs     Comic viewer (loads PageManager + SceneManager)
│   ├── dashboard/
│   │   ├── index.ejs            Editor dashboard
│   │   └── studio/preview/preview.ejs  Page preview panel
│   └── shared/
│       ├── head.ejs             <head> partial
│       └── main.ejs             Layout shell
├── libs/                        Client-side rendering libs (served at /libs/)
│   ├── pageInitializer.js       Bootstraps individual pages (media + scene)
│   ├── SpeechBubble/            Dialogue bubble renderer
│   ├── TextBlock/               Narrative text renderer
│   ├── ActionText/              Action effect text
│   ├── TiltEffect/              3D tilt parallax
│   ├── gsap/                    GSAP animation
│   ├── threeJsSphere.js         Three.js CRT sphere effect
│   ├── threeJsVideoCube.js      Three.js video cube
│   └── water.js / parallax.js   Visual effect helpers
├── Library/
│   └── layouts/
│       ├── portrait/            Portrait HTML panel templates (*.html)
│       ├── landscape/           Landscape HTML panel templates
│       └── styles/base-comic-layout.css  Base layout CSS
└── utils/                       Misc helpers (script-to-PDF converters)
```

---

## Route Inventory

### HTML Pages (`routes/routes.js`)

| Route | Controller | View | Auth |
|---|---|---|---|
| `GET /` | `SiteController.getLandingPage` | `landing/index.ejs` | public |
| `GET /login` | `SiteController.getLogin` | `auth/index.ejs` | public |
| `GET /library` | `SiteController.getLibrary` | `reader/browser/index.ejs` | user |
| `GET /library/series/:seriesId` | `LibraryController.getSeriesVolumes` | `reader/browser/series.ejs` | user |
| `GET /library/series/:seriesId/volume/:volumeId` | `LibraryController.getVolumeChapters` | `reader/browser/volume.ejs` | user |
| `GET /dashboard` | `DashboardController.getDashboard` | `dashboard/index.ejs` | user |
| `GET /viewer` | `ViewerController.getViewer` | `reader/viewer/index.ejs` | user |

### API Routes (`api/api.js`) — all prefixed `/api`

**System**
| Method + Path | Controller | Auth |
|---|---|---|
| `GET /test` | inline | public |
| `GET /settings/global` | `SystemSettingsController.getGlobalSettings` | admin |
| `PUT /settings/global` | `SystemSettingsController.updateGlobalSettings` | admin |
| `POST /vision/scan` | `VisionController.processPendingDescriptions` | moderator |
| `POST /vision/stop` | `VisionController.stopVisionScan` | moderator |
| `GET /fonts` | `SiteController.getAvailableFonts` | user |

**Editor — Layout & Panels**
| Method + Path | Controller | Auth |
|---|---|---|
| `GET /editor/layouts` | `PageLayoutController.getLayouts` | moderator |
| `GET /editor/next-panel-id` | `PageLayoutController.getNextPanelId` | moderator |
| `POST /editor/change-layout` | `PageLayoutController.changeLayout` | moderator |
| `POST /editor/toggle-spread` | `PageLayoutController.toggleSpread` | moderator |
| `GET /editor/panels/:series/:volume/:chapter/:pageId` | `PageLayoutController.getPanels` | moderator |
| `GET /editor/preview/:series/:volume/:chapter/:pageId` | `PageLayoutController.servePreview` | moderator |

**Editor — Assets**
| Method + Path | Controller | Auth |
|---|---|---|
| `GET /editor/assets/:series/:volume/:chapter/:pageId/:type` | `AssetUploadController.getAssets` | moderator |
| `POST /editor/upload-asset` | `AssetUploadController.uploadAsset` | moderator |
| `POST /editor/flip-asset` | `AssetUploadController.flipAsset` | moderator |

**Editor — Page Data**
| Method + Path | Controller | Auth |
|---|---|---|
| `GET /editor/scene/:series/:volume/:chapter/:pageId` | `PageDataController.getScene` | moderator |
| `GET /editor/media/:series/:volume/:chapter/:pageId` | `PageDataController.getMedia` | moderator |
| `POST /editor/scene/:series/:volume/:chapter/:pageId` | `PageDataController.saveScene` | moderator |
| `POST /editor/media/:series/:volume/:chapter/:pageId` | `PageDataController.saveMedia` | moderator |
| `POST /editor/sync-page/:series/:volumeId/:chapter/:pageId` | `PageDataController.syncPage` | moderator |
| `GET /editor/plot-board/:series` | `PageDataController.getPlotBoard` | moderator |
| `POST /editor/plot-board/:series` | `PageDataController.savePlotBoard` | moderator |

**Editor — Page Structure (admin)**
| Method + Path | Controller |
|---|---|
| `GET /editor/next-page-id` | `PageStructureController.getNextPageId` |
| `GET /editor/chapter-range` | `PageStructureController.getChapterRange` |
| `POST /editor/create-page` | `PageStructureController.createPage` |
| `POST /editor/insert-page` | `PageStructureController.insertPage` |
| `POST /editor/reorder-pages` | `PageStructureController.reorderPages` |
| `POST /editor/create-chapter` | `PageStructureController.createChapter` |

**Export (admin)**
| Method + Path | Controller |
|---|---|
| `POST /editor/export-volume/:series/:volume` | `ExportController.exportVolume` |
| `POST /editor/combine-pdf/:series/:volume` | `ExportController.combinePdf` — build PDF from existing PNGs; `?preset=&chapters=1,3-5` (blank = whole volume) |
| `POST /editor/export-script/:series/:volume` | `ExportController.exportScript` |

**Characters**
| Method + Path | Controller | Auth |
|---|---|---|
| `GET /characters` | `CharacterController.getAll` | user |
| `GET /characters/:name` | `CharacterController.getOne` | user |
| `POST /characters` | `CharacterController.create` | user |
| `PUT /characters/:id` | `CharacterController.update` | user |
| `DELETE /characters/:id` | `CharacterController.delete` | user |
| `POST /characters/:id/avatar` | `CharacterController.uploadAvatar` | user |
| `POST /characters/:id/analyze-avatar` | `CharacterController.analyzeAvatar` | user |
| `POST /characters/:id/reference` | `CharacterController.uploadReferenceImage` | user |

**Library & Volumes**
| Method + Path | Controller | Auth |
|---|---|---|
| `GET /library/series` | `LibraryController.getSeries` | user |
| `GET /library/series/:seriesId` | `LibraryController.getSeriesDetails` | user |
| `PUT /library/series/:seriesId/settings` | `LibraryController.updateSeriesSettings` | moderator |
| `GET /landing-page/library` | `LibraryController.getLandingLibrary` | public |
| `POST /volume/create` | `VolumeController.createVolume` | admin |
| `GET /volumes` | `VolumeController.getVolumes` | moderator |
| `GET /volumes/:volumeId/chapters` | `VolumeController.getChapters` | moderator |
| `GET /volumes/:volumeId/chapters/:chapterId` | `VolumeController.getChapterDetails` | moderator |
| `PUT /volumes/:volumeId/chapters/:chapterId` | `VolumeController.updateChapter` | moderator |
| `GET /volume/:id` | `VolumeController.getVolumeById` | user |
| `GET /volume/:id/chapter/:chapterNumber` | `VolumeController.getChapterPages` | user |

**Media**
| Method + Path | Controller | Auth |
|---|---|---|
| `GET /images/:series/volumes/*path` | `MediaController.serveImage` | user |
| `GET /images/volumes/*path` | `MediaController.serveImage` | user |
| `GET /images/:series/:volume/:chapter/:pageId/assets/:file` | `MediaController.servePageImage` | user |
| `GET /images/:series/characters/:charId/:type/:file` | `MediaController.serveCharacterImage` | user |
| `GET /scene/:series/:volume/:chapter/:pageId` | `MediaController.getScene` | user |
| `GET /media/:series/:volume/:chapter/:pageId` | `MediaController.getMedia` | user |
| `GET /landing-page/images` | `MediaController.getLandingPageImages` | public |

**Style Lab**
| Method + Path | Controller | Auth |
|---|---|---|
| `GET /style-lab/:seriesId` | `StyleLabController.getSettings` | moderator |
| `PUT /style-lab/:seriesId` | `StyleLabController.updateSettings` | moderator |
| `POST /style-lab/upload-css` | `StyleLabController.uploadCss` | moderator |
| `POST /style-lab/delete-css` | `StyleLabController.deleteCss` | moderator |

**Story Critic**
| Method + Path | Controller | Auth |
|---|---|---|
| `GET /critic/analyze/:series/:volumeId` | `CriticController.analyzeVolume` | user |

**Admin — Library Roots & Scanning**
| Method + Path | Controller |
|---|---|
| `GET /library/roots` | `ScheduledTaskController.getLibraryRoots` |
| `POST /library/roots` | `ScheduledTaskController.addLibraryRoot` |
| `DELETE /library/roots/:id` | `ScheduledTaskController.deleteLibraryRoot` |
| `POST /library/scan` | `ScheduledTaskController.triggerScan` |

**Auth** (`/authentication`)
| Method + Path | Notes |
|---|---|
| `POST /authentication/login` | bcrypt verify, sets `req.session.userId` |
| `POST /authentication/logout` | destroys session |

---

## Feature-to-File Map

> Use this when you know *what* to change but not *where*.

| Feature / Concern | Primary Files |
|---|---|
| Server startup, middleware order | `server.js` |
| Add a new API endpoint | `api/api.js` (declare route) + new or existing controller |
| Add a new HTML page | `routes/routes.js` + controller + `views/` EJS template |
| Session / auth logic | `middleware/auth.js`, `authentication/authentication.js` |
| Page layout system (panel grids) | `Library/layouts/portrait/` or `landscape/` HTML files, `controllers/PageLayoutController.js`, `services/LayoutService.js` |
| Panel image uploads | `controllers/AssetUploadController.js` → `Sharp` processing |
| Speech bubbles / dialogue | `libs/SpeechBubble/`, `services/public/SceneManager.js`, `controllers/PageDataController.js` |
| Narrator / text blocks | `libs/TextBlock/`, same flow as dialogue |
| Page metadata (scene cues, media) | `page.json` files on disk + `controllers/PageDataController.js` + `services/VolumeService.js` |
| Filesystem → DB sync | `api/scanLibrary.js` → `services/VolumeService.js` |
| Comic reader / viewer UI | `views/reader/viewer/index.ejs`, `services/public/PageManager.js`, `services/public/SceneManager.js`, `libs/pageInitializer.js` |
| Print export (PDF/PNG) | `controllers/ExportController.js` (Puppeteer pipeline) |
| AI vision scanning | `controllers/VisionController.js` → `services/gemini/GeminiVisionService.js` |
| Story critique | `controllers/CriticController.js` → `services/gemini/GeminiCriticService.js` |
| Character management | `controllers/CharacterController.js` → `services/CharacterService.js` + `models/Character.js` |
| Per-series styles (fonts, bubbles) | `controllers/StyleLabController.js` → `models/Series.js` |
| Global app settings | `controllers/SystemSettingsController.js` → `models/GlobalSettings.js` |
| Real-time progress (Socket.io) | `server.js` (io setup), `app.locals.io` passed to controllers |
| Static assets served to client | `/views` → `views/` dir, `/layouts` → `Library/layouts/`, `/libs` → `libs/`, `/services/public` → `services/public/` |
| Three.js / visual effects | `libs/threeJsSphere.js`, `libs/threeJsVideoCube.js`, `libs/water.js`, `libs/TiltEffect/` |
| Dashboard editor UI | `views/dashboard/index.ejs` + `controllers/DashboardController.js` |

---

## Data Model Summary

```
Series
  ├─ title, folderName (unique), description, coverImage
  ├─ bubbleFonts[], bubbleColors[], narratorStyle, monologueStyle
  └─ customCssFiles[] → served from views/public/

Volume
  ├─ seriesId (ref Series)
  └─ chapters[]
       └─ pages[]
            ├─ index, path (relative to page.json)
            ├─ layout: { id, html, css }
            ├─ header: { ... }  ← raw page.json header cache
            ├─ mediaData: { panelClass: imagePath, ... }
            └─ sceneData: [ { type, content, style, ... }, ... ]

Character
  ├─ name, description, avatarPath, referencePaths[]
  ├─ voiceId (ElevenLabs), defaultStyle
  └─ geminiDescription (from avatar analysis)

User
  ├─ email, passwordHash
  ├─ role: "basic" | "moderator" | "admin"
  └─ age (must be 18+)

LibraryRoot
  └─ path (absolute filesystem path scanned for Series dirs)

GlobalSettings
  └─ singleton document with system-wide config flags
```

**Filesystem layout for a page:**
```
{SeriesFolder}/Volumes/volume-N/chapter-X/pageY/
  ├── page.json     ← source of truth for layout, media, scene
  ├── page.css      ← page-specific styles
  ├── page.js       ← onPageLoad(container, pageInfo) hook
  ├── panels/       ← uploaded panel images
  └── masks/        ← reveal mask images
```

---

## Dev Standards

- **Guard clauses first:** Handle fallback/error conditions at the top of functions; avoid nesting.
- **No inline styles:** Custom formatting goes in standalone CSS modules.
- **No emojis** in code, commits, or comments.
- **Console output:** Descriptive and direct — include `[ControllerName]` prefix tags.
- `page.json` is the source of truth for page config; the MongoDB Volume cache is derived from it via sync.
- The Viewer bypasses the DB cache and reads `page.json` directly via `libs/pageInitializer.js`.
- Spread mode groups 2 pages per slot; `exportSecret` mode forces single-page rendering for Puppeteer.
- **Page numbers are global across a volume, not per-chapter.** `chapter-1` ends
  at page14, `chapter-2` starts at page15. So "is this page id free?" can only be
  answered at the volume level — use `VolumeService.findPageOwner`, never a
  `readdir` of the target chapter. Adding a page to the end of a chapter that
  isn't the last one is an **insert**, not a create: `page59` already exists and
  every later chapter has to shift. `VolumeService.insertPage` does that shift;
  `createPage` cannot and now refuses. Duplicates are invisible in the studio and
  only bite at print time, because `ExportController` names renders by page
  number alone (`page060_FULL.png`) — of two page60s, whichever renders second
  silently overwrites the other. `VolumeService.checkVolumeIntegrity` audits a
  volume; the export refuses to run when it finds a collision.

---

## Angled Layout Templates

Layouts that cut panels on a diagonal (`2_Panel_Angled_Split`,
`4_Panel_Vertical_Angled_Split`, `4_Panel_Staggered_Angled_Split`) use
`clip-path` rather than grid areas. Read the comment block in
`4_Panel_Vertical_Angled_Split.html` before building or editing one — it
documents the full method. The four traps worth knowing up front:

- **Never hand-tune two panels against each other.** `clip-path` percentages
  resolve against each panel's *own* box, so a shared cut has different numbers
  in each. Define every cut in page coordinates (0-100 across the page), take
  each panel's bounding box, then convert. Seams then meet by construction.
- **Gutters come from shifting both endpoints of a cut on one axis** — X for a
  near-vertical cut, Y for a near-horizontal one — by an equal amount, in
  opposite directions for the two panels. Equal shifts keep the edges parallel
  so the gutter stays a constant width. Use a length (px), not a percentage, or
  it varies with panel box size.
- **`clip-path` is applied after `filter`**, so `filter: drop-shadow()` on a
  clipped panel is generated and then clipped away — it renders nothing.
  `box-shadow` is clipped off too. A panel shadow requires an
  `absolute; inset: 0` wrapper around the panel (a static one collapses, since
  `filter` establishes a containing block) plus `pointer-events` handling so the
  stacked wrappers do not eat editor clicks. Deliberately not used.
- **Insetting a corner on two axes needs a slope term.** Where a cut meets a
  page edge, that corner is inset by `--edge` on *both* axes — but moving
  `--edge` along x on a sloped line also moves you along the line, so the inner
  edge lands off the true inset line and tilts against the outer one. The border
  then tapers across the page while still averaging `--edge` in the middle,
  which is easy to miss. Add `--skew = |cut slope in px| * --edge` to the
  corner's other axis, signed so it follows the line. Measure it with
  `utils/renderLayoutPreview.js` — the 2-panel layout shipped with a border
  running 1.5px to 5.0px before this was caught.
- **A two-class layout selector loses to `base-comic-layout.css`.** It styles
  `.section-container.page.page-layout`, so `.page-layout.layout-x { padding }`
  or `{ background }` is silently ignored. `2_Panel_Angled_Split` shipped with
  two dead declarations for that reason. Match the full selector when
  overriding.

Panel borders cannot be `border` (clip-path cuts it off). Each panel's
`::after` paints the frame on top as a ring — the panel shape inset by `--edge`
punched out of an oversized rectangle via `polygon(evenodd, ...)` — which the
panel's own clip-path then trims back to the panel shape.

**Do not draw the frame by clipping the `img` to an inset polygon.** It looks
equivalent (the img shares the panel's coordinate space) but `clip-path` is
resolved in an element's local space *before its own transform*, and
`page.json` media entries routinely carry one — `page77` panel-B has
`scale(1.10)` with a shifted `transform-origin`, saved while framing the art.
That scales the img's clip with the picture: border doubled on one side, gone
on the other. Placeholder art in a test render will never show this; art with a
saved transform will. A wrapper element inside the panel is not an option
either — `libs/pageInitializer.js` clears `panel.innerHTML` before every
render. Pseudo-elements survive because they are not part of `innerHTML`.
