const mongoose = require('../services/db');
const Volume = require('../models/Volume');
const Series = require('../models/Series');

async function checkFlags() {
    try {
        await mongoose.connect('mongodb://localhost:27017/VeilSite');
        console.log("Connected to DB.");

        const volumes = await Volume.find({}).populate('series');
        console.log(`Total Volumes in DB: ${volumes.length}`);

        for (const vol of volumes) {
            const seriesName = vol.series ? vol.series.title : "Unknown";
            let flaggedCount = 0;
            
            for (const chap of vol.chapters) {
                for (const page of chap.pages) {
                    const pending = (page.mediaData?.media || []).filter(m => m.DescriptionUpdateRequired);
                    flaggedCount += pending.length;
                }
            }
            
            console.log(`Series: ${seriesName} | Volume: ${vol.index} | Flagged Panels: ${flaggedCount}`);
        }

    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
}

checkFlags();