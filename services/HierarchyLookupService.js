/**
 * services/HierarchyLookupService.js
 *
 * Canonical resolution utilities for the full content hierarchy:
 *   Series -> Volume -> Chapter -> Page
 *
 * Also owns resolveSeriesPath, which builds the absolute filesystem root
 * for any series. This function is used broadly across controllers and
 * services and must live here rather than in a domain-specific file.
 *
 * Exports:
 *   resolveSeriesPath      - Resolves a series identifier to its absolute FS path.
 *   getSeriesFolderName    - Resolves a series ID or folderName to a folderName string.
 *   findVolumeId           - Resolves a volume folder + series to a Volume ObjectId.
 *   resolvePageHierarchy   - Resolves a full Series > Volume > Chapter > Page chain.
 *   fetchPageDataField     - Fetches a specific field from a resolved page.
 */

const path = require('path');
const mongoose = require('./db');
const Series = require('../models/Series');
const Volume = require('../models/Volume');
const LibraryRoot = require('../models/LibraryRoot');

/**
 * Resolves a series identifier (ObjectId or folderName) to its absolute
 * filesystem path. Uses the series' registered LibraryRoot when available,
 * falling back to the internal Library directory.
 *
 * @param {string} seriesIdentifier - A MongoDB ObjectId string or folderName.
 * @returns {Promise<string>} Absolute path to the series root directory.
 */
async function resolveSeriesPath(seriesIdentifier) {
    let query = { folderName: seriesIdentifier };
    if (mongoose.Types.ObjectId.isValid(seriesIdentifier)) {
        query = { _id: seriesIdentifier };
    }

    const series = await Series.findOne(query).populate('libraryRoot');
    if (series && series.libraryRoot && series.libraryRoot.path) {
        return path.join(series.libraryRoot.path, series.folderName);
    }

    // Fallback: internal Library directory
    const folderName = series ? series.folderName : seriesIdentifier;
    return path.join(__dirname, '..', 'Library', folderName);
}

/**
 * Resolves a series identifier (ObjectId or folderName) to a folderName string.
 * Falls back to returning the identifier as-is if no DB match is found.
 *
 * @param {string} identifier - A MongoDB ObjectId string or folderName.
 * @returns {Promise<string|null>}
 */
async function getSeriesFolderName(identifier) {
    if (!identifier) return null;

    if (mongoose.Types.ObjectId.isValid(identifier)) {
        try {
            const series = await Series.findById(identifier);
            if (series) return series.folderName;
        } catch (e) {
            console.error('[HierarchyLookupService] Error resolving series ID:', e);
        }
    }

    try {
        const seriesByFolder = await Series.findOne({ folderName: identifier });
        if (seriesByFolder) return seriesByFolder.folderName;
    } catch (e) { /* not found by folderName, fall through */ }

    return identifier;
}

/**
 * Resolves a volume folder name + series folder name to a Volume ObjectId.
 *
 * @param {string} volumeFolderName  - e.g. 'volume-1'
 * @param {string} seriesFolderName  - e.g. 'no-overflow'
 * @returns {Promise<mongoose.Types.ObjectId|null>}
 */
async function findVolumeId(volumeFolderName, seriesFolderName) {
    if (!seriesFolderName) throw new Error('seriesFolderName is required for findVolumeId');

    const seriesDoc = await Series.findOne({ folderName: seriesFolderName });
    const query = { volumePath: new RegExp(`[\\\\/]${volumeFolderName}$`) };
    if (seriesDoc) query.series = seriesDoc._id;

    const vol = await Volume.findOne(query);
    return vol ? vol._id : null;
}

/**
 * Resolves a full page within the hierarchy: Series > Volume > Chapter > Page.
 *
 * @param {string} volumeFolder      - e.g. 'volume-1'
 * @param {string} chapterId         - e.g. 'chapter-3'
 * @param {string} pageId            - e.g. 'page5'
 * @param {string} seriesFolderName  - e.g. 'no-overflow'
 * @returns {Promise<{ok: boolean, page?: Object, status?: number, message?: string}>}
 */
async function resolvePageHierarchy(volumeFolder, chapterId, pageId, seriesFolderName) {
    if (!seriesFolderName) throw new Error('seriesFolderName is required');

    let query = { folderName: seriesFolderName };
    if (mongoose.Types.ObjectId.isValid(seriesFolderName)) {
        query = { _id: seriesFolderName };
    }

    const seriesDoc = await Series.findOne(query);
    if (!seriesDoc) return { ok: false, status: 404, message: 'Series not found' };

    const volPathRegex = new RegExp(`${volumeFolder}[\\\\/]?$`, 'i');
    const volume = await Volume.findOne({
        volumePath: volPathRegex,
        series: seriesDoc._id,
    });
    if (!volume) return { ok: false, status: 404, message: 'Volume not found in this series' };

    const chapterNum = parseInt(chapterId.replace('chapter-', ''));
    const chapter = volume.chapters.find(c => c.chapterNumber === chapterNum);
    if (!chapter) return { ok: false, status: 404, message: 'Chapter not found' };

    const pageIndex = parseInt(pageId.replace('page', '')) || 0;
    const page = chapter.pages.find(p => p.index === pageIndex);
    if (!page) return { ok: false, status: 404, message: 'Page not found' };

    return { ok: true, page };
}

/**
 * Fetches a specific data field from a fully resolved page.
 *
 * @param {string} volumeFolder
 * @param {string} chapterId
 * @param {string} pageId
 * @param {string} seriesFolderName
 * @param {string} fieldName        - The page property to return (e.g. 'mediaData').
 * @param {*}      defaultValue     - Returned when the field is absent.
 * @returns {Promise<{ok: boolean, [fieldName]: *, status?: number, message?: string}>}
 */
async function fetchPageDataField(volumeFolder, chapterId, pageId, seriesFolderName, fieldName, defaultValue) {
    try {
        const result = await resolvePageHierarchy(volumeFolder, chapterId, pageId, seriesFolderName);
        if (!result.ok) return result;

        console.log(`[HierarchyLookupService] Serving cached ${fieldName} for: ${pageId}`);
        return { ok: true, [fieldName]: result.page[fieldName] || defaultValue };
    } catch (err) {
        console.error(`[HierarchyLookupService] Error serving ${fieldName} for ${pageId}:`, err);
        return { ok: false, status: 500, message: 'Internal Server Error' };
    }
}

module.exports = {
    resolveSeriesPath,
    getSeriesFolderName,
    findVolumeId,
    resolvePageHierarchy,
    fetchPageDataField,
};
