const fs = require('fs');
const path = require('path');
const mongoose = require('../services/db');
const Series = require('../models/Series');
const LibraryRoot = require('../models/LibraryRoot');

// Database Connection
const connectDB = async () => {
    if (mongoose.connection.readyState === 0) {
        await mongoose.connect('mongodb://localhost:27017/VeilSite');
        console.log('MongoDB Connected for Scanner');
    }
};

async function ensureDefaultRoot() {
    const defaultPath = path.resolve(__dirname, '..', 'Library');
    
    let root = await LibraryRoot.findOneAndUpdate(
        { name: "Internal Library" }, // Find by unique name
        { 
            $setOnInsert: { 
                name: "Internal Library",
                path: defaultPath,
                isActive: true
            }
        },
        { upsert: true, new: true }
    );
    
    // Ensure path is updated if it changed (though unlikely for Internal)
    if (root.path !== defaultPath) {
        root.path = defaultPath;
        await root.save();
    }
    
    return root;
}

async function scanLibrary(io = null) {
    await connectDB();
    await ensureDefaultRoot();

    const roots = await LibraryRoot.find({ isActive: true });
    console.log(`Scanning ${roots.length} active Library Roots...`);
    if (io) io.emit('scanner_progress', { message: `> Scanning ${roots.length} active Library Roots...`, percentage: 5 });

    const allDetectedSeries = [];
    let totalSeriesFound = 0;

    for (let i = 0; i < roots.length; i++) {
        const root = roots[i];
        console.log(`--- Scanning Root: ${root.name} (${root.path}) ---`);
        if (io) io.emit('scanner_progress', { message: `> Checking Root: ${root.name}`, percentage: 10 + (i / roots.length) * 10 });
        
        if (!fs.existsSync(root.path)) {
            console.warn(`Warning: Path does not exist for root ${root.name}: ${root.path}`);
            continue;
        }

        const entries = fs.readdirSync(root.path, { withFileTypes: true });

        for (let j = 0; j < entries.length; j++) {
            const entry = entries[j];
            if (entry.isDirectory()) {
                const seriesPath = path.join(root.path, entry.name);
                const volumesPath = path.join(seriesPath, 'Volumes');
                
                // Validation: Must contain a Volumes folder
                if (fs.existsSync(volumesPath) && fs.lstatSync(volumesPath).isDirectory()) {
                    console.log(`Found valid series structure: ${entry.name}`);
                    totalSeriesFound++;
                    if (io) io.emit('scanner_progress', { 
                        message: `> Found series: ${entry.name}`, 
                        percentage: 20 + Math.min(60, (totalSeriesFound * 5)) 
                    });
                    
                    const seriesData = {
                        title: entry.name,
                        folderName: entry.name,
                        libraryRoot: root._id,
                        libraryRootPath: root.path
                    };

                    const seriesDoc = await syncSeriesToDB(seriesData);
                    if (seriesDoc) {
                        allDetectedSeries.push(seriesDoc);
                        await scanVolumesInSeries(seriesDoc, volumesPath, entry.name, io);
                    }
                }
            }
        }
    }

    if (io) io.emit('scanner_progress', { message: `> Finishing up...`, percentage: 95 });
    return allDetectedSeries;
}

const Volume = require('../models/Volume');
const VolumeService = require('../services/VolumeService');

async function scanVolumesInSeries(seriesDoc, volumesPath, seriesFolderName, io = null) {
    const volumeFolders = fs.readdirSync(volumesPath).filter(f => {
        return fs.lstatSync(path.join(volumesPath, f)).isDirectory() && f.startsWith('volume-');
    });

    console.log(`Checking ${volumeFolders.length} volume folders in ${seriesFolderName}...`);
    if (io) io.emit('scanner_progress', { message: `  > Syncing ${volumeFolders.length} volumes for ${seriesFolderName}...` });

    for (const volFolder of volumeFolders) {
        const absolutePath = path.join(volumesPath, volFolder);
        const volIndex = parseInt(volFolder.replace('volume-', '')) || 0;
        
        // Construct a virtual path compatible with the engine's /Library route
        const expectedVolumePath = `/Library/${seriesFolderName}/Volumes/${volFolder}`;

        // FIRST: Find by series and index (Most stable during renames)
        let volume = await Volume.findOne({ series: seriesDoc._id, index: volIndex });

        if (!volume) {
            // SECOND: Fallback to finding by path (Legacy or manual move)
            volume = await Volume.findOne({ volumePath: expectedVolumePath, series: seriesDoc._id });
        }

        if (!volume) {
            console.log(`New Volume detected: ${volFolder} for series ${seriesDoc.title}`);
            volume = new Volume({
                series: seriesDoc._id,
                index: volIndex,
                title: `${seriesDoc.title} - Volume ${volIndex}`,
                volumePath: expectedVolumePath,
                chapters: []
            });
            await volume.save();

        } else {
            // Path Reconciliation: If the folder name changed, update the path
            if (volume.volumePath !== expectedVolumePath) {
                console.log(`Path mismatch detected for ${volume.title}. Updating: ${volume.volumePath} -> ${expectedVolumePath}`);
                volume.volumePath = expectedVolumePath;
                await volume.save();
            }
        }

        // ALWAYS: Ensure volume is linked to the series
        if (!seriesDoc.volumes.includes(volume._id)) {
            console.log(`Linking existing volume ${volume.title} to series ${seriesDoc.title}`);
            seriesDoc.volumes.push(volume._id);
            await seriesDoc.save();
        }

        // Sync chapters and pages
        await VolumeService.updateChaptersFromFS(volume, absolutePath);
    }
}

async function syncSeriesToDB(data) {
    try {
        let series = await Series.findOne({ folderName: data.folderName });
        
        if (!series) {
            console.log(`New Series detected! Creating DB entry for: ${data.title}`);
            series = new Series({
                title: data.title,
                folderName: data.folderName,
                libraryRoot: data.libraryRoot,
                description: "Auto-detected by Library Scanner",
                volumes: []
            });
            await series.save();
        } else {
            // Update existing if root was missing or changed
            let changed = false;
            if (!series.libraryRoot || series.libraryRoot.toString() !== data.libraryRoot.toString()) {
                series.libraryRoot = data.libraryRoot;
                changed = true;
            }
            if (changed) {
                await series.save();
                console.log(`Updated existing series metadata: ${data.title}`);
            }
        }

        // --- Ensure custom speech bubble folder and files exist ---
        try {
            const seriesPath = path.join(data.libraryRootPath, data.folderName);
            const customDir = path.join(seriesPath, 'custom', 'speechBubble');
            if (!fs.existsSync(customDir)) {
                fs.mkdirSync(customDir, { recursive: true });
                console.log(`Created custom speech bubble directory: ${customDir}`);
            }
            
            const tagsJsonPath = path.join(customDir, 'tags.json');
            if (!fs.existsSync(tagsJsonPath)) {
                fs.writeFileSync(tagsJsonPath, JSON.stringify([], null, 2));
                console.log(`Created empty tags.json: ${tagsJsonPath}`);
            }

            const tagsCssPath = path.join(customDir, 'tags.css');
            if (!fs.existsSync(tagsCssPath)) {
                fs.writeFileSync(tagsCssPath, '/* Custom Speech Bubble Styles */\n');
                console.log(`Created empty tags.css: ${tagsCssPath}`);
            }
        } catch (err) {
            console.error(`Failed to verify custom directories for ${data.title}:`, err.message);
        }

        return series;
    } catch (e) {
        console.error(`Error syncing ${data.title}:`, e);
        return null;
    }
}

if (require.main === module) {
    (async () => {
        try {
            await scanLibrary();
            console.log("Scan complete.");
        } catch (err) {
            console.error("Scan failed:", err);
        } finally {
            mongoose.disconnect();
        }
    })();
}

module.exports = { scanLibrary };