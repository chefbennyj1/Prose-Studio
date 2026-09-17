const mongoose = require('../services/db');
const Series = require('../models/Series');
const Volume = require('../models/Volume');
const path = require('path');
const fs = require('fs').promises;

// Fallback series location for a Series with no registered LibraryRoot. The
// bundled Library/ folder went with the panel layouts, so this path normally
// does not exist — cover lookups against it simply miss and fall back to the
// default image, which is the same behaviour as an empty folder.
const libraryRoot = path.join(__dirname, '..', 'Library');

/**
 * Cover art lookup. Previously lived in MediaService, which was deleted with
 * the rest of the panel-image pipeline — this is the only piece that outlived
 * it, because a book still has a cover even when it has no panels.
 */
async function findCoverImage(dirPath, baseName) {
    for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
        const fileName = `${baseName}.${ext}`;
        try {
            await fs.access(path.join(dirPath, fileName));
            return fileName;
        } catch (e) {
            // Not this extension; try the next.
        }
    }
    return null;
}

exports.getSeries = async (req, res) => {
    try {
        // Convert to lean() to allow modification of the result object
        const seriesList = await Series.find({}).sort({ title: 1 }).populate('libraryRoot').lean();

        for (const series of seriesList) {
            if (series.folderName) {
                // Determine Series Directory
                let seriesDir;
                if (series.libraryRoot && series.libraryRoot.path) {
                    seriesDir = path.join(series.libraryRoot.path, series.folderName);
                } else {
                    seriesDir = path.join(libraryRoot, series.folderName);
                }

                const coverFile = await findCoverImage(seriesDir, 'folder');
                
                if (coverFile) {
                    // Force forward slashes for URLs
                    series.coverImage = `/Library/${series.folderName}/${coverFile}`;
                } else {
                    series.coverImage = '/views/public/images/folder.png'; // Default
                }
            }
        }

        res.json({ ok: true, series: seriesList });
    } catch (err) {
        console.error("Error fetching series:", err);
        res.status(500).json({ ok: false, message: "Server error" });
    }
};

exports.getSeriesDetails = async (req, res) => {
    const { seriesId } = req.params;
    try {
        const series = await fetchSeriesByIdOrName(seriesId);
        if (!series) {
            return res.status(404).json({ ok: false, message: "Series not found" });
        }

        const seriesDir = resolveSeriesDir(series);

        if (series.folderName) {
            series.coverImage = await resolveCoverImage(seriesDir, series.folderName, 'folder');
        }

        if (series.volumes) {
            await populateVolumeCovers(series, seriesDir);
        }

        res.json({ ok: true, series });
    } catch (err) {
        console.error(`Error fetching series details for ${seriesId}:`, err);
        res.status(500).json({ ok: false, message: "Server error" });
    }
};

async function fetchSeriesByIdOrName(seriesId) {
    if (mongoose.Types.ObjectId.isValid(seriesId)) {
        return await Series.findById(seriesId).populate('volumes').populate('libraryRoot').lean();
    }
    return await Series.findOne({ 
        $or: [
            { folderName: seriesId }, 
            { title: { $regex: new RegExp(`^${seriesId}$`, 'i') } }
        ] 
    }).populate('volumes').populate('libraryRoot').lean();
}

function resolveSeriesDir(series) {
    if (series.libraryRoot && series.libraryRoot.path) {
        return path.join(series.libraryRoot.path, series.folderName);
    }
    return path.join(libraryRoot, series.folderName);
}

async function resolveCoverImage(dir, folderName, coverName, isVolume = false) {
    const coverFile = await findCoverImage(dir, coverName);
    if (!coverFile) return '/views/public/images/folder.png';
    
    if (isVolume) {
        return `/Library/${folderName}/Volumes/${coverName}/${coverFile}`;
    }
    return `/Library/${folderName}/${coverFile}`;
}

async function populateVolumeCovers(series, seriesDir) {
    for (const volume of series.volumes) {
        const volumeDirName = `volume-${volume.index}`; 
        const volumeDir = path.join(seriesDir, 'Volumes', volumeDirName);
        const coverName = `volume-${volume.index}`;
        
        volume.coverImage = await resolveCoverImage(volumeDir, series.folderName, volumeDirName, true);
        // Specifically look for volume-{index} file name
        const specificCover = await findCoverImage(volumeDir, coverName);
        if (specificCover) {
            volume.coverImage = `/Library/${series.folderName}/Volumes/${volumeDirName}/${specificCover}`;
        }
    }
}

exports.updateSeriesSettings = async (req, res) => {
    const { seriesId } = req.params;
    const { settings } = req.body;

    try {
        const series = await Series.findById(seriesId);
        if (!series) {
            return res.status(404).json({ ok: false, message: "Series not found" });
        }

        if (settings) {
            series.settings = { ...series.settings, ...settings };
            await series.save();
        }

        res.json({ ok: true, message: "Settings updated", settings: series.settings });
    } catch (err) {
        console.error("Error updating series settings:", err);
        res.status(500).json({ ok: false, message: "Server error" });
    }
};
