const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");
const { resolveSeriesPath } = require("../services/HierarchyLookupService");
const { getSeriesFolderName, findVolumeId } = require('../services/HierarchyLookupService');
const Volume = require("../models/Volume");
const Series = require("../models/Series");
const VolumeService = require("../services/VolumeService");
const NotificationService = require("../services/NotificationService");

/**
 * Shared by insertChapter/insertPage: alerts the acting user when a shift
 * broke print-spread alignment (see checkSpreadIntegrity in VolumeService.js).
 * Links to the FIRST broken page by its post-shift name — compromisedSpreads
 * entries carry both oldIndex/pageId (pre-shift, already stale by the time
 * this runs) and newIndex (the folder's actual current name), so newIndex is
 * what must be used here.
 */
async function notifyCompromisedSpreads(req, { series, volume, compromisedSpreads }) {
  if (!compromisedSpreads || compromisedSpreads.length === 0) return;
  if (!req.session?.userId) return;

  const first = [...compromisedSpreads].sort((a, b) => a.newIndex - b.newIndex)[0];
  const firstPageId = `page${first.newIndex}`;

  const title = compromisedSpreads.length === 1
    ? "1 page spread broken by an insert"
    : `${compromisedSpreads.length} page spreads broken by an insert`;

  const body = `Inserting pages pushed ${compromisedSpreads.length} page(s) out of print-spread alignment, starting at ${firstPageId}. Insert one more page immediately before it to restore alignment for the rest of the book.`;

  try {
    await NotificationService.create({
      user: req.session.userId,
      source: 'System',
      title,
      body,
      link: { series, volume, chapter: first.chapter, pageId: firstPageId }
    }, req.app.locals.io);
  } catch (err) {
    console.error("[PageStructureController] Failed to create spread-break notification:", err);
  }
}

/**
 * Audits the volume after any structural change and notifies the acting user if
 * a page number ended up owned by two chapters. Silent when the volume is
 * clean, so it is safe to call after every mutation.
 *
 * Worth notifying about rather than just logging: a duplicate is invisible in
 * the studio and only bites at print time, where the export silently drops one
 * of the two pages (see checkVolumeIntegrity in VolumeService.js).
 */
async function notifyIntegrityProblems(req, { series, volume }) {
  let report;
  try {
    const seriesFolderName = await getSeriesFolderName(series);
    const seriesPath = await resolveSeriesPath(seriesFolderName);
    report = await VolumeService.checkVolumeIntegrity(path.join(seriesPath, "Volumes", volume));
  } catch (err) {
    console.error("[PageStructureController] Volume integrity check failed:", err);
    return null;
  }

  if (report.ok) return report;

  console.warn(`[PageStructureController] ${volume} has ${report.duplicates.length} duplicated page number(s):`,
    report.duplicates.map(d => `${d.pageId} in ${d.chapters.join(' + ')}`).join('; '));

  if (!req.session?.userId) return report;

  const first = report.duplicates[0];
  const title = report.duplicates.length === 1
    ? `${first.pageId} exists in two chapters`
    : `${report.duplicates.length} page numbers exist in two chapters`;

  const body = `${first.pageId} is claimed by ${first.chapters.join(' and ')}. ` +
    `Print export names files by page number alone, so only one of the two will survive a volume export. ` +
    `Use Insert Page to renumber the later chapter before exporting.`;

  try {
    await NotificationService.create({
      user: req.session.userId,
      source: 'System',
      title,
      body,
      link: { series, volume, chapter: first.chapters[first.chapters.length - 1], pageId: first.pageId }
    }, req.app.locals.io);
  } catch (err) {
    console.error("[PageStructureController] Failed to create integrity notification:", err);
  }

  return report;
}

exports.createPage = async (req, res) => {
  const { series, volume, chapter, pageId, layout } = req.body;

  if (!volume || !chapter || !pageId || !layout) {
    return res.status(400).json({ ok: false, message: "Missing required fields" });
  }

  try {
    const seriesFolderName = await getSeriesFolderName(series);
    const seriesPath = await resolveSeriesPath(seriesFolderName);
    const volumesDir = path.join(seriesPath, "Volumes");
    const volumePath = path.join(volumesDir, volume);
    const pageDir = path.join(volumePath, chapter, pageId);

    if (fs.existsSync(pageDir)) {
      return res.status(400).json({ ok: false, message: "Page already exists" });
    }

    // A free slot in THIS chapter can still be owned by a later one, because
    // page numbers run continuously across the volume. Creating it anyway is
    // how chapter-5 and chapter-6 both ended up with a page60 -- which the
    // print exporter resolves by silently overwriting one of them.
    const owner = await VolumeService.findPageOwner(volumePath, pageId);
    if (owner) {
      return res.status(400).json({
        ok: false,
        message: `${pageId} already exists in ${owner}. Page numbers are global across a volume, ` +
          `so appending to a chapter that is not the last one needs Insert Page instead -- ` +
          `it shifts ${owner} and every chapter after it to make room.`
      });
    }

    fs.mkdirSync(pageDir, { recursive: true });
    fs.mkdirSync(path.join(pageDir, "assets", "image"), { recursive: true });

    const layoutId = layout.replace(".html", "");
    const pageJson = {
      header: {
        version: "2.0",
        layout: { id: layoutId, html: `${layoutId}.html`, css: "" }
      },
      media: [],
      scene: []
    };

    const css = `@import url('/layouts/styles/base-comic-layout.css');\n\n/* Add page-specific styles here */\n.${pageId} {\n\n}`;
    const js = "export async function onPageLoad(container, pageInfo) {\n" +
      "    container.addEventListener('view_visible', async () => {\n" +
      "        console.log(`Page ${pageInfo.pageId} is visible.`);\n" +
      "    });\n\n" +
      "    container.addEventListener('view_hidden', () => {\n" +
      "        console.log(`Page ${pageInfo.pageId} is hidden.`);\n" +
      "    });\n\n" +
      "    container.addEventListener('panel_media_changed', (e) => {\n" +
      "        const { panelSelector, type, fileName, action } = e.detail;\n" +
      "        console.log(`Panel ${panelSelector} changed:`, { type, fileName, action });\n" +
      "    });\n" +
      "}";

    fs.writeFileSync(path.join(pageDir, `page.css`), css);
    fs.writeFileSync(path.join(pageDir, `page.js`), js);
    fs.writeFileSync(path.join(pageDir, `page.json`), JSON.stringify(pageJson, null, 2));

    const volumeId = await findVolumeId(volume, seriesFolderName);
    if (volumeId) {
      const Volume = require('../models/Volume');
      const vol = await Volume.findById(volumeId);
      if (vol) await VolumeService.updateChaptersFromFS(vol);
    }
    await notifyIntegrityProblems(req, { series, volume });
    res.json({ ok: true, message: `Page ${pageId} created successfully.`, path: pageDir });
  } catch (err) {
    console.error("Scaffolding Error:", err);
    res.status(500).json({ ok: false, message: "Failed to create page structure" });
  }
};

exports.getNextPageId = async (req, res) => {
  const { series, volume, chapter } = req.query;
  if (!series || !volume || !chapter) {
    return res.status(400).json({ ok: false, message: "Missing required parameters" });
  }
  try {
    const seriesFolderName = await getSeriesFolderName(series);
    const seriesPath = await resolveSeriesPath(seriesFolderName);
    const volumePath = path.join(seriesPath, "Volumes", volume);
    const chapterPath = path.join(volumePath, chapter);

    if (!fs.existsSync(chapterPath)) return res.json({ ok: true, nextPageId: "page0", available: true, ownedBy: null });

    const folders = fs.readdirSync(chapterPath).filter(f =>
      f.startsWith("page") && fs.statSync(path.join(chapterPath, f)).isDirectory()
    );

    let maxNum = -1;
    folders.forEach(f => {
      const num = parseInt(f.replace("page", ""));
      if (!isNaN(num) && num > maxNum) maxNum = num;
    });

    const nextPageId = `page${maxNum + 1}`;

    // The number after this chapter's last page belongs to the NEXT chapter
    // unless this is the final chapter, since page numbers run continuously
    // across the volume. Report who owns it instead of handing back an id that
    // Create Page cannot legally write.
    const owner = await VolumeService.findPageOwner(volumePath, nextPageId);

    res.json({
      ok: true,
      nextPageId,
      available: !owner,
      ownedBy: owner,
      insertPoint: owner ? maxNum + 1 : null
    });
  } catch (err) {
    console.error("Next Page ID Error:", err);
    res.status(500).json({ ok: false, message: "Failed to determine next page ID" });
  }
};

exports.insertPage = async (req, res) => {
  const { series, volume, chapter, insertPoint } = req.body;
  if (!series || !volume || !chapter || insertPoint === undefined) {
    return res.status(400).json({ ok: false, message: "Missing required fields" });
  }
  try {
    const result = await VolumeService.insertPage({ series, volume, chapter, insertPoint });
    await notifyCompromisedSpreads(req, { series, volume, compromisedSpreads: result.compromisedSpreads });
    await notifyIntegrityProblems(req, { series, volume });
    res.json(result);
  } catch (err) {
    console.error("Insert Page Error:", err);
    res.status(500).json({ ok: false, message: err.message });
  }
};

exports.reorderPages = async (req, res) => {
  const { series, volume, chapter, newOrder } = req.body;
  if (!series || !volume || !chapter || !newOrder) {
    return res.status(400).json({ ok: false, message: "Missing required fields: series, volume, chapter, newOrder" });
  }
  try {
    const result = await VolumeService.reorderPages({ series, volume, chapter, newOrder });
    res.json(result);
  } catch (err) {
    console.error("Reorder Pages Error:", err);
    res.status(500).json({ ok: false, message: err.message });
  }
};

exports.getChapterRange = async (req, res) => {
  const { series, volume, chapter } = req.query;
  if (!series || !volume || !chapter) {
    return res.status(400).json({ ok: false, message: "Missing required parameters" });
  }
  try {
    const range = await VolumeService.getChapterRange({ series, volume, chapter });
    res.json({ ok: true, range });
  } catch (err) {
    console.error("Get Chapter Range Error:", err);
    res.status(500).json({ ok: false, message: err.message });
  }
};

exports.insertChapter = async (req, res) => {
  const { series, volume, chapterIndex, title } = req.body;
  if (!series || !volume || chapterIndex === undefined) {
    return res.status(400).json({ ok: false, message: "Missing required fields" });
  }
  try {
    const result = await VolumeService.insertChapter({ series, volume, chapterIndex, title });
    await notifyCompromisedSpreads(req, { series, volume, compromisedSpreads: result.compromisedSpreads });
    await notifyIntegrityProblems(req, { series, volume });
    res.json(result);
  } catch (err) {
    console.error("Insert Chapter Error:", err);
    res.status(500).json({ ok: false, message: err.message });
  }
};

exports.createChapter = async (req, res) => {
  const { series, volume, chapterIndex, title } = req.params.series ? req.params : req.body;
  if (!series || !volume || !chapterIndex) {
    return res.status(400).json({ ok: false, message: "Missing required fields" });
  }
  try {
    const seriesFolderName = await getSeriesFolderName(series);
    const result = await VolumeService.createChapter({
      seriesFolderName,
      volumeFolderName: volume,
      chapterIndex,
      title: title || "New Chapter"
    });
    res.json(result);
  } catch (err) {
    console.error("Create Chapter Error:", err);
    res.status(500).json({ ok: false, message: err.message });
  }
};
