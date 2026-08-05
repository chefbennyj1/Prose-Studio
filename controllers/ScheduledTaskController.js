const LibraryRoot = require('../models/LibraryRoot');
const { scanLibrary } = require('../api/scanLibrary');
const VolumeService = require('../services/VolumeService');
const NotificationService = require('../services/NotificationService');
const fs = require('fs');
const path = require('path');

/**
 * Sweeps every volume for page numbers owned by two chapters and notifies the
 * user who ran the scan. This is the only check that catches a collision the
 * studio did not cause -- a page folder renamed or copied in Explorer.
 *
 * A module-level function rather than a class method because the route handlers
 * are handed to Express unbound, so `this` is undefined inside them.
 */
async function reportBrokenVolumes(req, io) {
    let broken;
    try {
        broken = await VolumeService.checkAllVolumesIntegrity();
    } catch (err) {
        console.error("[ScheduledTask] Volume integrity sweep failed:", err);
        return [];
    }

    if (broken.length === 0) {
        console.log("[ScheduledTask] Page numbering verified across all volumes.");
        return [];
    }

    for (const report of broken) {
        console.warn(`[ScheduledTask] ${report.seriesTitle} / ${report.volume}: ` +
            report.duplicates.map(d => `${d.pageId} in ${d.chapters.join(' + ')}`).join('; '));
    }

    if (!req.session?.userId) return broken;

    const first = broken[0];
    const firstDupe = first.duplicates[0];
    const totalDupes = broken.reduce((sum, r) => sum + r.duplicates.length, 0);

    const title = broken.length === 1
        ? `${first.volume} has ${first.duplicates.length} duplicated page number(s)`
        : `${totalDupes} duplicated page numbers across ${broken.length} volumes`;

    const body = `${firstDupe.pageId} of ${first.seriesTitle} ${first.volume} is claimed by ` +
        `${firstDupe.chapters.join(' and ')}. Print export names files by page number alone, so only one of ` +
        `them survives a volume export. Use Insert Page to renumber the later chapter.`;

    try {
        await NotificationService.create({
            user: req.session.userId,
            source: 'System',
            title,
            body,
            link: { series: first.series, volume: first.volume, chapter: firstDupe.chapters[firstDupe.chapters.length - 1], pageId: firstDupe.pageId }
        }, io);
    } catch (err) {
        console.error("[ScheduledTask] Failed to create integrity notification:", err);
    }

    return broken;
}

class ScheduledTaskController {
    
    async getLibraryRoots(req, res) {
        try {
            const roots = await LibraryRoot.find({ name: { $ne: "Internal Library" } }).sort({ name: 1 });
            res.json({ ok: true, roots });
        } catch (e) {
            res.status(500).json({ ok: false, message: e.message });
        }
    }

    async addLibraryRoot(req, res) {
        const { name, path: rootPath } = req.body;

        if (!name || !rootPath) {
            return res.status(400).json({ ok: false, message: "Name and Path are required." });
        }

        if (!fs.existsSync(rootPath)) {
            return res.status(400).json({ ok: false, message: "Path does not exist on server." });
        }

        try {
            const newRoot = new LibraryRoot({ name, path: rootPath });
            await newRoot.save();
            res.json({ ok: true, message: "Library Root added.", root: newRoot });
        } catch (e) {
            // Check for duplicate key error (code 11000)
            if (e.code === 11000) {
                return res.status(400).json({ ok: false, message: "Name or Path already exists." });
            }
            res.status(500).json({ ok: false, message: e.message });
        }
    }

    async deleteLibraryRoot(req, res) {
        try {
            const root = await LibraryRoot.findById(req.params.id);
            if (root && root.name === "Internal Library") {
                return res.status(403).json({ ok: false, message: "Cannot delete internal system root." });
            }
            await LibraryRoot.findByIdAndDelete(req.params.id);
            res.json({ ok: true, message: "Library Root removed." });
        } catch (e) {
            res.status(500).json({ ok: false, message: e.message });
        }
    }

    async triggerScan(req, res) {
        try {
            // Standard Library Sync (Local Filesystem)
            const io = req.app.locals.io;
            const results = await scanLibrary(io);

            // The follow-up vision scan went with the panel-image pipeline;
            // there are no images left to hash.

            const integrity = await reportBrokenVolumes(req, io);

            res.json({
                ok: true,
                message: `Library synchronization complete.`,
                results,
                brokenVolumes: integrity
            });
        } catch (e) {
            console.error("Manual Scan Error:", e);
            res.status(500).json({ ok: false, message: "Scan failed: " + e.message });
        }
    }
}

module.exports = new ScheduledTaskController();
