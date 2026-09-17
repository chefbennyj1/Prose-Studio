const path = require("path");
const fs = require("fs");
const mongoose = require("../services/db");
const { resolveSeriesPath } = require("../services/HierarchyLookupService");
const { getSeriesFolderName, findVolumeId } = require('../services/HierarchyLookupService');
const Volume = require("../models/Volume");
const Series = require("../models/Series");
const VolumeService = require("../services/VolumeService");

async function savePageDataAndSync(pageData, pageJsonPath, volume, chapter, pageId, seriesFolderName) {
    if (!pageData.header) pageData.header = {};
    pageData.header.lastUpdated = new Date();

    fs.writeFileSync(pageJsonPath, JSON.stringify(pageData, null, 2));

    // The user requested to disable auto-sync on every save to reduce DB load
    // The "Sync to DB" button in the visual editor handles this manually now.
    // const volumeId = await findVolumeId(volume, seriesFolderName);
    // if (volumeId) {
    //   await VolumeService.syncSinglePage(volumeId, chapter, pageId, seriesFolderName);
    // }
}

async function getPagePaths(series, volume, chapter, pageId) {
    const seriesFolderName = await getSeriesFolderName(series);
    const seriesPath = await resolveSeriesPath(seriesFolderName);
    const pageDir = path.join(seriesPath, "Volumes", volume, chapter, pageId);
    const pageJsonPath = path.join(pageDir, "page.json");
    return { seriesFolderName, seriesPath, pageDir, pageJsonPath };
}

// saveMedia / getMedia / getScene / saveScene lived here to serve the comic
// editor: panel image mappings and dialogue-balloon cues. Both concepts went
// with the panel pipeline, and their routes are gone. What survives is page
// structure sync and the plot board, which are about story, not artwork.

exports.syncPage = async (req, res) => {
  const { series, volumeId, chapter, pageId } = req.params;
  try {
    const seriesFolderName = await getSeriesFolderName(series);
    const volumeDbId = await findVolumeId(volumeId, seriesFolderName);
    if (!volumeDbId) throw new Error("Volume not found");
    const result = await VolumeService.syncSinglePage(volumeDbId, chapter, pageId, seriesFolderName);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
};

exports.getPlotBoard = async (req, res) => {
  const { series } = req.params;
  try {
    const seriesFolderName = await getSeriesFolderName(series);
    const seriesPath = await resolveSeriesPath(seriesFolderName);
    const plotPath = path.join(seriesPath, 'plot_board.json');

    if (fs.existsSync(plotPath)) {
      const data = JSON.parse(fs.readFileSync(plotPath, 'utf8'));
      res.json({ ok: true, board: data });
    } else {
      res.json({ ok: true, board: [] });
    }
  } catch (e) {
    console.error("getPlotBoard Error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
};

exports.savePlotBoard = async (req, res) => {
  const { series } = req.params;
  const { board } = req.body;
  try {
    const seriesFolderName = await getSeriesFolderName(series);
    const seriesPath = await resolveSeriesPath(seriesFolderName);
    const plotPath = path.join(seriesPath, 'plot_board.json');

    fs.writeFileSync(plotPath, JSON.stringify(board, null, 2));
    res.json({ ok: true, message: 'Plot board saved' });
  } catch (e) {
    console.error("savePlotBoard Error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
};
