## Agent Status
<!-- Update your line before starting work. Clear it when done. -->
**GEMINI:** idle
**CLAUDE:** Narrator (Kokoro live read-back), CodeMirror writing surface, and
Story/Chapter rail menus - all in the tree, uncommitted. Chapter render to file
not started.

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
