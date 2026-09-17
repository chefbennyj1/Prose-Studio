const fs = require('fs');
const path = require('path');
const mongoose = require('./db');
const VolumeModel = require('../models/Volume');
const Series = require('../models/Series');
const { resolveSeriesPath } = require('./HierarchyLookupService');
const { getSeriesFolderName } = require('./HierarchyLookupService');

async function syncVolumeToDB(seriesFolderName, volumeFolderName) {
    const seriesDoc = await Series.findOne({ folderName: seriesFolderName });
    const volPathRegex = new RegExp(`${volumeFolderName}[\\\\/]?$`, 'i');
    const volume = await VolumeModel.findOne({ 
        volumePath: volPathRegex, 
        series: seriesDoc ? seriesDoc._id : { $exists: false } 
    });
    if (volume) await updateChaptersFromFS(volume);
}

async function getSortedSubdirectories(dirPath, prefix, returnNumbers = false) {
    if (!fs.existsSync(dirPath)) return [];
    const dirs = (await fs.promises.readdir(dirPath, { withFileTypes: true }))
        .filter(d => d.isDirectory() && d.name.startsWith(prefix));
    if (returnNumbers) {
        return dirs.map(d => parseInt(d.name.replace(/\D/g, '')) || 0).sort((a, b) => a - b);
    }
    return dirs.map(d => d.name).sort((a, b) => (parseInt(a.replace(/\D/g, '')) || 0) - (parseInt(b.replace(/\D/g, '')) || 0));
}

const DEFAULT_JS = `export async function onPageLoad(container, pageInfo) {
    container.addEventListener('view_visible', async () => { console.log(\`Page \${pageInfo.pageId} is visible.\`); });
    container.addEventListener('view_hidden', () => { console.log(\`Page \${pageInfo.pageId} is hidden.\`); });
    container.addEventListener('panel_media_changed', (e) => {
        const { panelSelector, type, fileName, action } = e.detail;
        console.log('Panel ' + panelSelector + ' changed:', { type, fileName, action });
    });
}`;

const DEFAULT_CSS = (pageId) => `@import url('/layouts/styles/base-comic-layout.css');

.\${pageId} {

}`;

async function createVolume({ index, title, seriesId, firstChapterTitle }) {

  
  const seriesDoc = await Series.findById(seriesId);
  if (!seriesDoc) throw new Error("Series not found");

  const seriesFolderName = seriesDoc.folderName;
  const volumeFolderName = `volume-${index}`;
  
  // Resolve the absolute path for physical directory creation
  const seriesPath = await resolveSeriesPath(seriesFolderName);
  const absoluteVolumePath = path.join(seriesPath, 'Volumes', volumeFolderName);

  // Check if volume with this index already exists for THIS series
  const existing = await VolumeModel.findOne({ index, series: seriesId });
  if (existing) throw Error("Existing Volume for this series");

  // Physical directory creation
  if (!fs.existsSync(absoluteVolumePath)) {
      fs.mkdirSync(absoluteVolumePath, { recursive: true });
  }

  // Create First Chapter (Chapter 1)
  const firstChapterNum = 1;
  const chapterFolderName = `chapter-${firstChapterNum}`;
  const absoluteChapterPath = path.join(absoluteVolumePath, chapterFolderName);
  if (!fs.existsSync(absoluteChapterPath)) {
      fs.mkdirSync(absoluteChapterPath, { recursive: true });
  }

  // Create First Page (Page 1)
  const firstPageNum = 1;
  const pageFolderName = `page${firstPageNum}`;
  const absolutePagePath = path.join(absoluteChapterPath, pageFolderName);
  if (!fs.existsSync(absolutePagePath)) {
      fs.mkdirSync(absolutePagePath, { recursive: true });
      
      // Create assets folders
      fs.mkdirSync(path.join(absolutePagePath, 'assets', 'image'), { recursive: true });
      fs.mkdirSync(path.join(absolutePagePath, 'assets', 'audio'), { recursive: true });

      // Create default page.json
      const defJson = {
          header: { 
              version: "2.0", 
              layout: { id: "Standard_Page", html: "Standard_Page.html", css: "" }
          },
          media: [], scene: []
      };
      fs.writeFileSync(path.join(absolutePagePath, 'page.json'), JSON.stringify(defJson, null, 2));
      
      // Create default page.js and page.css
      fs.writeFileSync(path.join(absolutePagePath, 'page.js'), DEFAULT_JS);
      fs.writeFileSync(path.join(absolutePagePath, 'page.css'), DEFAULT_CSS(pageFolderName));
  }

  // Store volumePath in the internal format used by the scanner (/Library/Series/Volumes/volume-N)
  const volumePath = `/Library/${seriesFolderName}/Volumes/${volumeFolderName}`;

  const newVolume = new VolumeModel({ 
      series: seriesId,
      index, 
      title, 
      volumePath, 
      chapters: [
          {
              title: firstChapterTitle || "Chapter 1",
              chapterNumber: firstChapterNum,
              pages: []
          }
      ] 
  });

  await newVolume.save();
  // We pass the absolute path to updateChaptersFromFS to ensure it can scan immediately
  let volumeWithData = await updateChaptersFromFS(newVolume, absoluteVolumePath);
  await volumeWithData.save();
  return true;
}

async function updateChaptersFromFS(volume, explicitPath = null) {
  try {
    const projectRoot = path.resolve(__dirname, '..');
    let volumeBaseDir = explicitPath;
    
    if (!volumeBaseDir) {
        // Resolve series folder name from the volume path (e.g., /Library/No_Overflow/Volumes/volume-1)
        const pathParts = volume.volumePath.split('/').filter(p => p.length > 0);
        const seriesFolderName = pathParts[1]; // Index 1 is the folder name after 'Library'
        
        if (!seriesFolderName) throw new Error("Could not determine series from volumePath: " + volume.volumePath);
        

        const seriesPath = await resolveSeriesPath(seriesFolderName);
        
        // Extract the volume subfolder (e.g., volume-1)
        const volumeSubFolder = path.basename(volume.volumePath);
        
        volumeBaseDir = path.join(seriesPath, 'Volumes', volumeSubFolder);
    }
        
    console.log(`[Scanner] Scanning: ${volumeBaseDir}`);
    const chapterFolders = await getSortedSubdirectories(volumeBaseDir, 'chapter-');

    // Remove stale chapters
    const fsChapterNums = chapterFolders.map(f => parseInt(f.replace(/\D/g, '')) || 0);
    volume.chapters = volume.chapters.filter(c => fsChapterNums.includes(c.chapterNumber));

    for (const chapFolder of chapterFolders) {
      const chapterNumber = parseInt(chapFolder.replace(/\D/g, '')) || 0;
      const chapterPath = path.join(volumeBaseDir, chapFolder);

      let chapter = volume.chapters.find(c => c.chapterNumber === chapterNumber);
      if (!chapter) {
        chapter = { title: `Chapter ${chapterNumber}`, chapterNumber, pages: [] };
        volume.chapters.push(chapter);
      }

      const pageFolders = await getSortedSubdirectories(chapterPath, 'page');

      const pages = [];
      for (const pageFolder of pageFolders) {
        const folderPath = path.join(chapterPath, pageFolder);
        const atomicPath = path.join(folderPath, 'page.json');
        const jsPath = path.join(folderPath, 'page.js');
        const cssPath = path.join(folderPath, 'page.css');

        // 1. AUTO-SCAFFOLDING
        if (!fs.existsSync(atomicPath)) {
            console.log(`[Scanner] Scaffolding ${pageFolder}`);
            const defJson = {
                header: { 
                    version: "2.0", 
                    layout: { id: "Standard_Page", html: "Standard_Page.html", css: "" }
                },
                media: [], scene: []
            };
            
            fs.writeFileSync(atomicPath, JSON.stringify(defJson, null, 2));
        }
        
        // Ensure JS and CSS exist
        if (!fs.existsSync(jsPath)) fs.writeFileSync(jsPath, DEFAULT_JS);
        if (!fs.existsSync(cssPath)) fs.writeFileSync(cssPath, DEFAULT_CSS(pageFolder));

        // 2. PARSE ATOMIC DATA FOR CACHE
        let mediaData = { media: [] };
        let sceneData = [];
        let layout = { id: "Standard_Page", html: "Standard_Page.html", css: "" };
        let header = {};

        try {
            const raw = fs.readFileSync(atomicPath, 'utf8');
            const atomic = JSON.parse(raw);
            header = atomic.header || {};
            
            const layoutId = atomic.header?.layout?.id ?? "Standard_Page";
            layout = { id: layoutId, html: `${layoutId}.html`, css: "" };

            mediaData = { media: (atomic.media || []).map(m => {
                // If it's an image and has no description/alt, mark it as needing update
                if (m.type === 'image' && m.fileName && (!m.alt || !m.description)) {
                    m.DescriptionUpdateRequired = true;
                }
                return m;
            }) };
            sceneData = atomic.scene || [];
        } catch (e) { console.warn(`[Scanner] Error parsing ${atomicPath}:`, e.message); } 

        const pageIndex = parseInt(pageFolder.replace(/\D/g, '')) || 0;
        const urlPath = `${volume.volumePath}/${chapFolder}/${pageFolder}/page.json`.replace(/\\/g, '/');

        // Note: We always recalculate urlPath here to ensure it matches the current volume.volumePath
        pages.push({ index: pageIndex, path: urlPath, layout, header, mediaData, sceneData });
      }
      chapter.pages = pages;
    }

    volume.chapters.sort((a, b) => a.chapterNumber - b.chapterNumber);
    volume.markModified('chapters');
    await volume.save();
    console.log(`[Scanner] Volume ${volume.index} updated. Total Chapters: ${volume.chapters.length}`);
    return volume;
  } catch (err) {
    console.error(`[Scanner] Failed:`, err);
    return volume;
  }
}

async function syncSinglePage(volumeId, chapterId, pageId, seriesFolderName = null) {
    try {

        
        let volume;
        if (seriesFolderName) {
            const seriesDoc = await Series.findOne({ folderName: seriesFolderName });
            if (seriesDoc) {
                if (mongoose.Types.ObjectId.isValid(volumeId)) {
                    volume = await VolumeModel.findOne({ _id: volumeId, series: seriesDoc._id });
                } else {
                    const volPathRegex = new RegExp(`${volumeId}[\\\\/]?$`, 'i');
                    volume = await VolumeModel.findOne({ volumePath: volPathRegex, series: seriesDoc._id });
                }
            }
        }

        if (!volume && mongoose.Types.ObjectId.isValid(volumeId)) {
            volume = await VolumeModel.findById(volumeId).populate('series');
        }

        if (!volume) throw new Error("Volume not found");

        const actualSeriesFolderName = seriesFolderName || (volume.series ? volume.series.folderName : null) || (() => {
            const pathParts = volume.volumePath.split('/').filter(p => p.length > 0);
            return pathParts[1];
        })();

        if (!actualSeriesFolderName) throw new Error("Could not determine series folder name");
        
        const seriesPath = await resolveSeriesPath(actualSeriesFolderName);
        const volumeSubFolder = path.basename(volume.volumePath);
        const pageFolder = path.join(seriesPath, 'Volumes', volumeSubFolder, chapterId, pageId);
        const atomicPath = path.join(pageFolder, 'page.json');
        console.log(`[Sync] Refreshing ${pageId}`);
        const raw = fs.readFileSync(atomicPath, 'utf8');
        const atomic = JSON.parse(raw);

        const chapterNum = parseInt(chapterId.replace('chapter-', ''));
        const chapter = volume.chapters.find(c => c.chapterNumber === chapterNum);
        if (!chapter) throw new Error("Chapter not in DB");

        const pageIndex = parseInt(pageId.replace('page', '')) || 0;
        const pageEntry = chapter.pages.find(p => p.index === pageIndex);
        
        if (pageEntry) {
            pageEntry.header = atomic.header || {};
            
            const layoutId = atomic.header?.layout?.id ?? "Standard_Page";
            pageEntry.layout = { id: layoutId, html: `${layoutId}.html`, css: "" };
            
            // Clean up legacy keys from the DB entry
            if (pageEntry.layouts) delete pageEntry.layouts;

            pageEntry.mediaData = { media: (atomic.media || []).map(m => {
                if (m.type === 'image' && m.fileName && (!m.alt || !m.description)) {
                    m.DescriptionUpdateRequired = true;
                }
                return m;
            }) };
            pageEntry.sceneData = atomic.scene || [];
            volume.markModified('chapters');
            await volume.save();
            return { ok: true, page: pageEntry };
        }
        return { ok: false, message: "Page not in DB" };
    } catch (err) {
        return { ok: false, message: err.message };
    }
}

async function checkSpreadIntegrity(chapterPath, insertIdx) {
    const compromised = [];
    try {
        const pageDirs = (await fs.promises.readdir(chapterPath, { withFileTypes: true }))
            .filter(d => d.isDirectory() && d.name.startsWith('page'))
            .map(d => ({ name: d.name, num: parseInt(d.name.replace(/\D/g, '')) || 0 }))
            .sort((a, b) => a.num - b.num);

        for (const page of pageDirs) {
            // We only care about pages at or after the insertion point that will be shifted
            if (page.num < insertIdx) continue;

            const jsonPath = path.join(chapterPath, page.name, 'page.json');
            if (fs.existsSync(jsonPath)) {
                const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                const spreadType = data.header?.spread?.type;

                if (spreadType && spreadType !== 'none') {
                    // Parity check: Current system assumes Even indices are Left, Odd are Right (starting from page 1 as Cover/Right)
                    // If a page moves from Even to Odd (or vice-versa), its "Side" in the spread viewer flips.
                    const oldParity = page.num % 2 === 0 ? 'even' : 'odd';
                    const newParity = (page.num + 1) % 2 === 0 ? 'even' : 'odd';

                    if (oldParity !== newParity) {
                        compromised.push({
                            chapter: path.basename(chapterPath),
                            pageId: page.name,
                            oldIndex: page.num,
                            newIndex: page.num + 1,
                            type: spreadType
                        });

                        // Mark as broken in the file immediately
                        if (!data.header.spread) data.header.spread = {};
                        data.header.spread.isBroken = true;
                        fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
                    }
                }
            }
        }
    } catch (e) {
        console.error("[Spread Integrity] Check failed:", e);
    }
    return compromised;
}

/**
 * Which chapter in this volume owns a given page id, or null if it is free.
 *
 * Page numbers run continuously across a whole volume (chapter-1 ends at 14,
 * chapter-2 starts at 15), so "is this id available?" can only be answered at
 * the volume level. Checking only the target chapter is what allowed a second
 * page60 to be created in chapter-5 while chapter-6 already held one.
 */
async function findPageOwner(volumePath, pageId) {
    const chapterFolders = await getSortedSubdirectories(volumePath, 'chapter-');
    for (const chapFolder of chapterFolders) {
        if (fs.existsSync(path.join(volumePath, chapFolder, pageId))) return chapFolder;
    }
    return null;
}

/**
 * Audits a volume's page numbering and reports every number claimed by more
 * than one chapter.
 *
 * A duplicate is invisible in the studio -- both pages open and edit fine --
 * and only shows up at print time, because ExportController names its output
 * by page number alone (page060_FULL.png). Of two pages numbered 60, whichever
 * chapter renders second silently overwrites the other's PNG. That is how four
 * finished chapter-5 pages went missing from a volume export.
 *
 * Duplicates are errors; gaps are only reported, not judged. A gap is usually
 * a page the author pulled on purpose, a duplicate never is.
 */
async function checkVolumeIntegrity(volumePath) {
    const chapterFolders = await getSortedSubdirectories(volumePath, 'chapter-');
    const owners = new Map();

    for (const chapFolder of chapterFolders) {
        const chapterPath = path.join(volumePath, chapFolder);
        const pageDirs = (await fs.promises.readdir(chapterPath, { withFileTypes: true }))
            .filter(d => d.isDirectory() && /^page\d+$/.test(d.name));

        for (const dir of pageDirs) {
            const num = parseInt(dir.name.replace('page', ''), 10);
            if (!owners.has(num)) owners.set(num, []);
            owners.get(num).push(chapFolder);
        }
    }

    const numbers = [...owners.keys()].sort((a, b) => a - b);

    const duplicates = numbers
        .filter(n => owners.get(n).length > 1)
        .map(n => ({ pageNumber: n, pageId: `page${n}`, chapters: owners.get(n) }));

    const gaps = [];
    for (let n = numbers.length ? numbers[0] : 0; n < (numbers[numbers.length - 1] || 0); n++) {
        if (!owners.has(n)) gaps.push(n);
    }

    return {
        ok: duplicates.length === 0,
        volume: path.basename(volumePath),
        totalPages: numbers.reduce((sum, n) => sum + owners.get(n).length, 0),
        distinctPages: numbers.length,
        firstPage: numbers.length ? numbers[0] : null,
        lastPage: numbers.length ? numbers[numbers.length - 1] : null,
        duplicates,
        gaps
    };
}

/**
 * Sweeps every volume of every series, returning a report for each one whose
 * page numbering has broken. Runs off the library scan so a duplicate surfaces
 * even when it arrived out of band -- a page folder renamed in Explorer, or one
 * moved between chapters by hand -- not just when the studio caused it.
 */
async function checkAllVolumesIntegrity() {
    const broken = [];
    const seriesDocs = await Series.find({}, 'folderName title');

    for (const seriesDoc of seriesDocs) {
        let volumesDir;
        try {
            volumesDir = path.join(await resolveSeriesPath(seriesDoc.folderName), 'Volumes');
        } catch (err) {
            console.error(`[Integrity] Could not resolve path for series "${seriesDoc.folderName}":`, err.message);
            continue;
        }

        for (const volumeFolder of await getSortedSubdirectories(volumesDir, 'volume-')) {
            const report = await checkVolumeIntegrity(path.join(volumesDir, volumeFolder));
            if (report.ok) continue;
            broken.push({ series: seriesDoc.folderName, seriesTitle: seriesDoc.title, ...report });
        }
    }

    return broken;
}

async function tryRename(oldP, newP, retries = 5) {
    for (let i = 0; i < retries; i++) {
        try {
            await fs.promises.rename(oldP, newP);
            return;
        } catch (e) {
            if ((e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') && i < retries - 1) {
                const delay = Math.pow(2, i) * 100; // Exponential backoff: 100ms, 200ms, 400ms, 800ms
                await new Promise(r => setTimeout(r, delay));
            } else {
                e.message = `[Rename Error] Could not move "${path.basename(oldP)}". It may be open in another program (VS Code, File Explorer, etc). Details: ${e.message}`;
                throw e;
            }
        }
    }
}

/**
 * Shared by insertPage and insertChapter: safely shifts a list of numbered
 * folders (pages OR chapters) up by one slot each, without collisions.
 *
 * items: [{ oldPath, newPath, tempPath, label }] — label is just for error
 * messages, so a lock on "page113" and a lock on "chapter-9" report clearly.
 *
 * Three phases, run over the WHOLE list each time (not interleaved per item):
 *   0. Lock check — a non-destructive rename-and-back on every item, so a
 *      single locked folder is caught before ANYTHING actually moves.
 *   1. Temp rename — every item moves to a throwaway name first, so a folder
 *      being renamed to a slot another item currently occupies can never collide
 *      (this is why items must be pre-sorted highest-number-first by the caller).
 *   2. Final rename — every item moves from its temp name to its real new name.
 */
async function shiftNumberedFolders(items) {
    for (const item of items) {
        try {
            const testPath = item.oldPath + "_LOCK_TEST";
            await fs.promises.rename(item.oldPath, testPath);
            await fs.promises.rename(testPath, item.oldPath);
        } catch (e) {
            throw new Error(`PRE-FLIGHT ERROR: "${item.label}" is currently locked by another process. Please close all applications (VS Code, File Explorer, etc.) that might be using this folder and try again.`);
        }
    }

    for (const item of items) await tryRename(item.oldPath, item.tempPath);
    for (const item of items) await tryRename(item.tempPath, item.newPath);
}

async function insertPage({ series, volume: volumeFolderName, chapter: chapterFolderName, insertPoint }) {


    const seriesFolderName = await getSeriesFolderName(series);
    if (!seriesFolderName) throw new Error("Series folder name is required for insertPage");

    const seriesPath = await resolveSeriesPath(seriesFolderName);
    const volumePath = path.join(seriesPath, 'Volumes', volumeFolderName);
    
    if (!fs.existsSync(volumePath)) throw new Error("Volume directory not found");

    const insertIdx = parseInt(insertPoint);
    if (isNaN(insertIdx)) throw new Error("Invalid insert point");

    const chapterDirs = await getSortedSubdirectories(volumePath, 'chapter-');

    const targetChapIdx = chapterDirs.indexOf(chapterFolderName);
    if (targetChapIdx === -1) throw new Error("Target chapter not found in volume");

    // --- PHASE 0: PRE-FLIGHT LOCK CHECK & INTEGRITY SCAN ---
    const foldersToMove = [];
    let compromisedSpreads = [];

    for (let i = targetChapIdx; i < chapterDirs.length; i++) {
        const currentChapName = chapterDirs[i];
        const currentChapPath = path.join(volumePath, currentChapName);
        const isTargetChapter = (i === targetChapIdx);

        if (fs.existsSync(path.join(currentChapPath, '.ignore-shift'))) continue;

        // Check for spreads that will be broken in this chapter
        const chapterCompromised = await checkSpreadIntegrity(currentChapPath, isTargetChapter ? insertIdx : 0);
        compromisedSpreads = compromisedSpreads.concat(chapterCompromised);

        const pageDirs = (await fs.promises.readdir(currentChapPath, { withFileTypes: true }))
            .filter(d => d.isDirectory() && d.name.startsWith('page'))
            .map(d => ({ name: d.name, num: parseInt(d.name.replace(/\D/g, '')) || 0 }))
            .filter(p => isTargetChapter ? p.num >= insertIdx : true)
            .sort((a, b) => b.num - a.num);

        for (const page of pageDirs) {
            foldersToMove.push({
                chapName: currentChapName,
                oldName: page.name,
                newName: `page${page.num + 1}`,
                oldPath: path.join(currentChapPath, page.name),
                newPath: path.join(currentChapPath, `page${page.num + 1}`),
                tempPath: path.join(currentChapPath, `${page.name}_TEMP_SHIFT`),
                label: `${currentChapName}/${page.name}`
            });
        }
    }

    await shiftNumberedFolders(foldersToMove);

    // --- INTERNAL UPDATES (rename assets/etc. that carry the old page name, fix header) ---
    for (const item of foldersToMove) {
        await updateInternalFiles(item.newPath, item.oldName, item.newName);
    }

    // --- PHASE 3: SCAFFOLD NEW PAGE ---
    const targetChapterPath = path.join(volumePath, chapterFolderName);
    const newPageName = `page${insertIdx}`;
    const newPagePath = path.join(targetChapterPath, newPageName);

    let cloneSourcePath = path.join(targetChapterPath, `page${insertIdx + 1}`);
    let sourceName = `page${insertIdx + 1}`;
    if (!fs.existsSync(cloneSourcePath)) {
        cloneSourcePath = path.join(targetChapterPath, `page${insertIdx - 1}`);
        sourceName = `page${insertIdx - 1}`;
    }

    if (fs.existsSync(cloneSourcePath)) {
        await fs.promises.cp(cloneSourcePath, newPagePath, { recursive: true });
        await updateInternalFiles(newPagePath, sourceName, newPageName);
        const jsonPath = path.join(newPagePath, 'page.json');
        if (fs.existsSync(jsonPath)) {
            const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            data.media = []; data.scene = [];
            if (data.header?.spread) data.header.spread.type = 'none'; // Reset spread on new page
            fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
        }
    } else {
        fs.mkdirSync(newPagePath, { recursive: true });
        const jsonPath = path.join(newPagePath, 'page.json');
        const defaultData = {
            header: { version: "2.0", layout: { id: "Standard_Page", html: "Standard_Page.html", css: "" } },
            media: [],
            scene: []
        };
        fs.writeFileSync(jsonPath, JSON.stringify(defaultData, null, 2));
        fs.writeFileSync(path.join(newPagePath, 'page.js'), DEFAULT_JS);
        fs.writeFileSync(path.join(newPagePath, 'page.css'), DEFAULT_CSS(newPageName));
    }

    await syncVolumeToDB(seriesFolderName, volumeFolderName);

    let finalMessage = `Global Page Insertion complete at ${insertIdx}. Successfully shifted ${foldersToMove.length} pages.`;
    if (compromisedSpreads.length > 0) {
        finalMessage += ` WARNING: ${compromisedSpreads.length} page spread(s) were compromised by this shift. Check your page settings.`;
    }

    return {
        ok: true,
        message: finalMessage,
        compromisedSpreads: compromisedSpreads.length > 0 ? compromisedSpreads : null
    };
}

/**
 * Inserts a brand-new chapter at chapterIndex, shifting that chapter and every
 * chapter after it up by one — and every PAGE inside all of them by one too,
 * since page numbers are global across the volume, not per-chapter. The new
 * chapter is scaffolded with a single starter page (matching createChapter's
 * own page.json/js/css template); use the studio's existing Insert Page
 * feature afterward to add more.
 *
 * Reuses shiftNumberedFolders/checkSpreadIntegrity/updateInternalFiles from
 * insertPage rather than re-implementing the lock-check/temp-rename dance —
 * a chapter shift is that same operation one level up, run twice (once for
 * every page in every affected chapter, once for the chapter folders
 * themselves).
 */
async function insertChapter({ series, volume: volumeFolderName, chapterIndex, title }) {

    const seriesFolderName = await getSeriesFolderName(series);
    if (!seriesFolderName) throw new Error("Series folder name is required for insertChapter");

    const seriesPath = await resolveSeriesPath(seriesFolderName);
    const volumePath = path.join(seriesPath, 'Volumes', volumeFolderName);
    if (!fs.existsSync(volumePath)) throw new Error("Volume directory not found");

    const insertIdx = parseInt(chapterIndex);
    if (isNaN(insertIdx)) throw new Error("Invalid chapter index");

    const chapterDirs = await getSortedSubdirectories(volumePath, 'chapter-');
    const chapterNums = chapterDirs
        .map(name => parseInt(name.replace('chapter-', ''), 10))
        .filter(n => !isNaN(n));

    // Every chapter at or after the insertion point shifts up by one. Highest
    // first, same reason insertPage sorts descending: nothing can collide with
    // a slot that hasn't been vacated yet.
    const chaptersToShift = chapterNums.filter(n => n >= insertIdx).sort((a, b) => b - a);

    if (chaptersToShift.length === 0) {
        // Nothing occupies this slot or anything after it — this is really just
        // an append. Don't duplicate that logic, hand off to createChapter.
        return createChapter({ seriesFolderName, volumeFolderName, title, chapterIndex: insertIdx });
    }

    // --- PHASE 0: PRE-FLIGHT — every page in every shifting chapter, and the chapters themselves ---
    const pageMoves = [];
    const chapterMoves = [];
    let compromisedSpreads = [];
    let newChapterFirstPageNum = null; // the page slot the new chapter's starter page will take over

    for (const num of chaptersToShift) {
        const oldChapName = `chapter-${num}`;
        const newChapName = `chapter-${num + 1}`;
        const oldChapPath = path.join(volumePath, oldChapName);

        chapterMoves.push({
            oldPath: oldChapPath,
            newPath: path.join(volumePath, newChapName),
            tempPath: path.join(volumePath, `${oldChapName}_TEMP_SHIFT`),
            label: oldChapName
        });

        if (fs.existsSync(path.join(oldChapPath, '.ignore-shift'))) continue;

        // Every page in this chapter shifts — same spread-integrity check
        // insertPage uses, just applied to the whole chapter (insertIdx 0 = don't skip any page).
        const chapterCompromised = await checkSpreadIntegrity(oldChapPath, 0);
        compromisedSpreads = compromisedSpreads.concat(chapterCompromised);

        const pageDirs = (await fs.promises.readdir(oldChapPath, { withFileTypes: true }))
            .filter(d => d.isDirectory() && d.name.startsWith('page'))
            .map(d => ({ name: d.name, num: parseInt(d.name.replace(/\D/g, '')) || 0 }))
            .sort((a, b) => b.num - a.num);

        if (num === insertIdx && pageDirs.length > 0) {
            // The lowest page number in the chapter we're displacing is the slot
            // the new chapter's own first page takes over.
            newChapterFirstPageNum = pageDirs[pageDirs.length - 1].num;
        }

        for (const page of pageDirs) {
            pageMoves.push({
                oldPath: path.join(oldChapPath, page.name),
                newPath: path.join(oldChapPath, `page${page.num + 1}`),
                tempPath: path.join(oldChapPath, `${page.name}_TEMP_SHIFT`),
                label: `${oldChapName}/${page.name}`,
                oldName: page.name,
                newName: `page${page.num + 1}`
            });
        }
    }

    if (newChapterFirstPageNum === null) {
        throw new Error(`Chapter ${insertIdx} exists but has no pages (or they're all marked .ignore-shift) — cannot determine the new chapter's starting page number.`);
    }

    // --- PHASE 1: shift every PAGE first, while chapters still have their OLD folder names ---
    await shiftNumberedFolders(pageMoves);
    for (const item of pageMoves) {
        await updateInternalFiles(item.newPath, item.oldName, item.newName);
    }

    // --- PHASE 2: shift the CHAPTER folders themselves ---
    await shiftNumberedFolders(chapterMoves);

    // --- PHASE 3: scaffold the new chapter with a single starter page ---
    const newChapterFolderName = `chapter-${insertIdx}`;
    const newChapterPath = path.join(volumePath, newChapterFolderName);
    const firstPageName = `page${newChapterFirstPageNum}`;
    const firstPagePath = path.join(newChapterPath, firstPageName);

    await fs.promises.mkdir(firstPagePath, { recursive: true });
    await fs.promises.mkdir(path.join(firstPagePath, "assets", "image"), { recursive: true });

    const pageJson = {
        header: { version: "2.0", layout: { id: "Standard_Page", html: "Standard_Page.html", css: "" } },
        media: [], scene: []
    };
    await fs.promises.writeFile(path.join(firstPagePath, 'page.json'), JSON.stringify(pageJson, null, 2));
    await fs.promises.writeFile(path.join(firstPagePath, 'page.js'), DEFAULT_JS);
    await fs.promises.writeFile(path.join(firstPagePath, 'page.css'), DEFAULT_CSS(firstPageName));

    await syncVolumeToDB(seriesFolderName, volumeFolderName);

    let finalMessage = `Chapter ${insertIdx} inserted. Shifted ${chapterMoves.length} chapter(s) and ${pageMoves.length} page(s).`;
    if (compromisedSpreads.length > 0) {
        finalMessage += ` WARNING: ${compromisedSpreads.length} page spread(s) were compromised by this shift. Check your page settings.`;
    }

    return {
        ok: true,
        message: finalMessage,
        chapter: newChapterFolderName,
        pageId: firstPageName,
        compromisedSpreads: compromisedSpreads.length > 0 ? compromisedSpreads : null
    };
}

async function createChapter({ seriesFolderName, volumeFolderName, title, chapterIndex }) {

    const seriesPath = await resolveSeriesPath(seriesFolderName);
    const volumePath = path.join(seriesPath, 'Volumes', volumeFolderName);
    if (!fs.existsSync(volumePath)) throw new Error("Volume directory not found");

    const chapIdx = parseInt(chapterIndex);
    const chapterFolderName = `chapter-${chapIdx}`;
    const chapterPath = path.join(volumePath, chapterFolderName);
    if (fs.existsSync(chapterPath)) throw new Error(`Chapter ${chapIdx} already exists.`);

    const dirs = await fs.promises.readdir(volumePath, { withFileTypes: true });
    let maxPageNum = -1;
    for (const d of dirs) {
        if (d.isDirectory() && d.name.startsWith('chapter-')) {
            const chapDir = path.join(volumePath, d.name);
            const pageDirs = await fs.promises.readdir(chapDir, { withFileTypes: true });
            for (const pd of pageDirs) {
                if (pd.isDirectory() && pd.name.startsWith('page')) {
                    const pNum = parseInt(pd.name.replace('page', ''), 10);
                    if (!isNaN(pNum) && pNum > maxPageNum) maxPageNum = pNum;
                }
            }
        }
    }

    const nextPageNum = maxPageNum + 1;
    const firstPageName = `page${nextPageNum}`;
    const firstPagePath = path.join(chapterPath, firstPageName);

    await fs.promises.mkdir(chapterPath, { recursive: true });
    await fs.promises.mkdir(firstPagePath, { recursive: true });

    const pageJson = {
        header: { version: "2.0", layout: { id: "Standard_Page", html: "Standard_Page.html", css: "" } },
        media: [], scene: []
    };
    await fs.promises.writeFile(path.join(firstPagePath, 'page.json'), JSON.stringify(pageJson, null, 2));
    await fs.promises.writeFile(path.join(firstPagePath, 'page.js'), DEFAULT_JS);
    await fs.promises.writeFile(path.join(firstPagePath, 'page.css'), DEFAULT_CSS(firstPageName));
    await fs.promises.mkdir(path.join(firstPagePath, "assets", "image"), { recursive: true });


    await syncVolumeToDB(seriesFolderName, volumeFolderName);

    return { ok: true, message: `Chapter ${chapIdx} created`, chapter: chapterFolderName, pageId: firstPageName };
}

async function updateInternalFiles(dir, oldName, newName) {
    const files = await fs.promises.readdir(dir);
    for (const f of files) {
        if (f.startsWith(oldName)) { 
            const newF = f.replace(oldName, newName);
            await tryRename(path.join(dir, f), path.join(dir, newF));
        }
    }
    const jsonPath = path.join(dir, 'page.json');
    if (fs.existsSync(jsonPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            // Remove redundant fields if they exist
            if (data.header) {
                delete data.header.pageId;
                delete data.header.chapter;
                delete data.header.volume;
                fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
            }
        } catch(e) {}
    }
}

async function getChapterRange({ series, volume: volumeFolderName, chapter: chapterFolderName }) {


    const seriesFolderName = await getSeriesFolderName(series);
    if (!seriesFolderName) throw new Error("Series folder name is required");

    const seriesPath = await resolveSeriesPath(seriesFolderName);
    const chapterPath = path.join(seriesPath, 'Volumes', volumeFolderName, chapterFolderName);
    
    if (!fs.existsSync(chapterPath)) {
        return { min: 0, max: 0, count: 0, pages: [] };
    }

    const pageDirs = await getSortedSubdirectories(chapterPath, 'page', true);

    if (pageDirs.length === 0) {
        return { min: 0, max: 0, count: 0, pages: [] };
    }

    return {
        min: pageDirs[0],
        max: pageDirs[pageDirs.length - 1],
        count: pageDirs.length,
        pages: pageDirs
    };
}

async function reorderPages({ series, volume: volumeFolderName, chapter: chapterFolderName, newOrder }) {


    const seriesFolderName = await getSeriesFolderName(series);
    if (!seriesFolderName) throw new Error("Series folder name is required");

    const seriesPath = await resolveSeriesPath(seriesFolderName);
    const chapterPath = path.join(seriesPath, 'Volumes', volumeFolderName, chapterFolderName);
    
    if (!fs.existsSync(chapterPath)) throw new Error("Chapter directory not found");

    // 1. Validate the input order
    if (!Array.isArray(newOrder) || newOrder.length === 0) throw new Error("Invalid page order provided");

    // 2. Determine the starting index (we assume they want to keep the same range but different order)
    // Find the smallest index currently in the chapter
    const existingPages = await getSortedSubdirectories(chapterPath, 'page', true);

    if (existingPages.length === 0) throw new Error("No pages found to reorder");
    
    const startIdx = existingPages[0];

    // 3. Temporary rename phase to avoid collisions
    const tempMapping = [];
    for (const oldPageName of newOrder) {
        const oldPath = path.join(chapterPath, oldPageName);
        if (fs.existsSync(oldPath)) {
            const tempName = `reorder_${Math.random().toString(36).substr(2, 9)}_${oldPageName}`;
            const tempPath = path.join(chapterPath, tempName);
            await tryRename(oldPath, tempPath);
            tempMapping.push({ tempPath, tempName });
        } else {
            console.warn(`[Reorder] Page ${oldPageName} not found, skipping.`);
        }
    }

    // 4. Final rename phase to new sequential IDs
    for (let i = 0; i < tempMapping.length; i++) {
        const newIdx = startIdx + i;
        const newPageName = `page${newIdx}`;
        const finalPath = path.join(chapterPath, newPageName);
        
        const { tempPath, tempName } = tempMapping[i];
        
        await tryRename(tempPath, finalPath);
        
        // Use existing helper to update pageId inside page.json and rename assets if needed
        // Note: updateInternalFiles expects (dir, oldName, newName)
        // dir is the newPath, oldName is the ORIGINAL name before temp rename
        const originalName = tempName.split('_').slice(2).join('_'); 
        await updateInternalFiles(finalPath, originalName, newPageName);
    }

    // 5. Sync DB
    await syncVolumeToDB(seriesFolderName, volumeFolderName);

    return { ok: true, message: `Reordered ${tempMapping.length} pages starting from index ${startIdx}` };
}

/**
 * Iterates all Volume documents and syncs each one's chapters/pages from the filesystem.
 * Previously lived in VolumeSyncService — consolidated here as it is a direct VolumeService concern.
 */
async function updateVolumesFromFS() {
    const volumes = await VolumeModel.find();
    for (const vol of volumes) {
        const updatedVol = await updateChaptersFromFS(vol);
        const totalPages = updatedVol.chapters.reduce((sum, chapter) => sum + chapter.pages.length, 0);
        console.log(`[VolumeService] Updated volume ${updatedVol.title} with ${updatedVol.chapters.length} chapters and ${totalPages} pages.`);
    }
}

module.exports = { createVolume, populatePagesFromFS: updateChaptersFromFS, updateChaptersFromFS, syncSinglePage, insertPage, insertChapter, createChapter, getChapterRange, reorderPages, updateVolumesFromFS, findPageOwner, checkVolumeIntegrity, checkAllVolumesIntegrity };
