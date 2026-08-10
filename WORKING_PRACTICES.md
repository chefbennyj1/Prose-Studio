# Working Practices — for any agent working on this codebase

This document explains *how* to work here, not *what* the code is (that's
`Agents.md`). Follow it even when a task looks like a one-liner — especially
then. Written by Claude (Fable) from sessions with Ben; the rules below are
the ones that repeatedly made the difference between "looks done" and "is
done."

## The one-sentence version

Read the real thing before trusting any description of it; make the smallest
change that uses the architecture that's already there; then *watch the
change work* through the same interface a user would touch, and try to break
it, before you call it finished.

## Before touching anything

1. **Claim your status line** at the top of `Agents.md`. Clear it when done.
   Two agents work on this repo; this is how we avoid colliding.
2. **Verify claims against current code.** Memory, docs, commit messages, and
   your own recollection are all descriptions — the code is the fact.
   Example: the Proof-Reader was "known" to hook `page-open`; its manifest
   had moved to `scene-saved`. A whole verification run failed for that
   assumption. Read the manifest, the route table, the actual handler.
3. **Check who else uses what you're changing.** Grep for every caller of a
   route/function before changing its semantics. If the callers are all
   yours, you can change the contract cleanly; if not, you can't.

## Ben's house rules (non-negotiable)

- **Lean wins.** Every feature must serve the comic-making workflow. Prefer
  deleting to adding. If state already exists somewhere (e.g. the studio
  mirrors its working state into the URL), *use it* — don't build a parallel
  persistence mechanism.
- **No inline styles.** All styling goes in the proper CSS files (ui-kit).
  Match the existing component's class naming (`glass-*`, BEM-ish).
- **Labels tell the truth.** A button that deletes must not say "mark read."
  If behavior changes, the words on it change too — and flag the judgment
  call to Ben rather than deciding silently.
- **The AI is opt-in, and everything else is local.** This replaced
  "local-first AI is product identity", which said creative text never leaves
  the writer's machine and that swapping the local model for a cloud one must
  never be proposed. Ben retired that rule deliberately on 2026-08-09: the
  local Gemma ran on an 8192-token context, so it judged a chapter a fifth at
  a time, and the engine around it was the source of every failure the editor
  had. The AI is Gemini now.

  The commitment moved rather than disappeared, and the new form is the rule:
  **nothing reaches Google unless the writer switches AI on in Settings and
  supplies a key**, and until they do, the features that need it are not shown
  at all. Never make an AI feature the default, never make one reachable
  without that gate, and never let a local feature grow a cloud dependency —
  spelling, the mechanics scanner and the narrator all run offline and free,
  and they are what make the opt-in honest rather than nominal.
- **Commit and push in one step.** Never leave commits local. One commit per
  logical feature. Never sweep unrelated working-tree changes (or another
  agent's pending edits) into your commit — mention them instead.

## Verification: the part that actually makes you "thorough"

"The code looks right" and "the tests pass" are not evidence. Evidence is
the running app doing the thing while you watch. The recipe that works here:

1. **Drive the real surface.** This project ships Puppeteer — use it.
   - The dashboard shell needs a real session; the `exportSecret` bypass is
     not enough (`/api/user` still fails and bounces you to login).
   - Pattern: upsert a throwaway user directly in Mongo (bcrypt password,
     email like `verify_bot@local.test`), log in via `POST
     /authentication/login`, deep-link with
     `/dashboard?tab=...&vol=...&chap=...&page=...`, observe, screenshot,
     **delete the user when done**.
   - Login is rate-limited: 10 attempts per 15 min per IP. Budget them.
2. **Time-based UI needs a timeline, not a snapshot.** Poll the DOM in a
   loop and log every state change with timestamps. A screenshot proves a
   moment; a timeline proves behavior (e.g. pending badge at +1.7s, replaced
   by the result at +237s).
3. **Probe past the happy path.** After the feature works, try to break it
   at the same surface: the redirect with `returnTo=https://evil.example`,
   the DELETE with a foreign id, the double-fire, the cache-hit that must
   *not* flash UI. One probe that holds is worth three happy-path passes.
4. **When a test fails, suspect the test first.** Diagnose *why* before
   touching product code. Tonight's examples: a scan that "hung" had
   actually finished after the watcher gave up; a "cold" run was warm; a
   badge that "never appeared" was a plugin subscribed to a different hook.
5. **Know the environment's traps:**
   - nodemon restarts on any `.js/.ejs/.css` save — **don't edit server
     files while a verification run is in flight**; the restart kills
     in-flight requests and resets in-memory caches.
   - AI calls go to Gemini over the network, so they fail in ways a local
     model did not: no key, AI switched off, rate limits, and a request body
     that must stay under the 25mb parser limit. Check `/api/proofing/status`
     for whether the AI can run at all before blaming a scan.
   - Node resolves modules from the *script's* directory: scripts outside
     the repo must `require('E:/Sequential Comic Server/node_modules/...')`.

### Layout templates: render them standalone

Don't verify a layout template by loading a page in the studio and looking at
it. The page scales with the viewport, the gutters you are judging are a few
pixels wide, and you cannot see a box that is the wrong size — only the clipped
result of it.

```bash
node utils/renderLayoutPreview.js                     # list templates
node utils/renderLayoutPreview.js 6_Panel out.png     # render + measure
```

No server, no login, no Mongo — it inlines `base-comic-layout.css` in place of
the server-relative `@import` and renders the file directly. It puts labelled
placeholder art in every panel (a framed card with corner ticks, so whatever
`object-fit` crops shows up as a missing edge) and prints each panel's measured
box as a percentage of the page.

**The measurement table is the point, not the screenshot.** Compare it against
the box table in the template's comment. That is what catches a corner shifted
in the wrong direction, and it is how the drop-shadow that rendered *nothing*
was found — the screenshot just looked fine. A change-a-number-and-remeasure
loop runs in seconds; a browser refresh-and-squint loop does not converge.

## Reporting back to Ben

- **Lead with the outcome**, then evidence. Verdict, steps, findings.
- **Retract cleanly.** If you speculated and the code proves you wrong, say
  "I was wrong, here's the line that shows it" — Ben's instincts about his
  own system are usually right.
- **Surface what you noticed but didn't do**: pre-existing anomalies in the
  working tree, a slow scan, a misleading label. Findings that aren't bugs
  are still findings.
- Ben is a 25-year chef turned developer who writes at night. Skip the
  basics, keep sentences plain, and when there's a judgment call, present
  it as one — with your recommendation first.
