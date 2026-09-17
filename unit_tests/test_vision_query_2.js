const mongoose = require('../services/db');
const Volume = require('../models/Volume');
const Series = require('../models/Series'); // Registered now

async function testQuery() {
    try {
        await mongoose.connect('mongodb://localhost:27017/VeilSite');
        console.log("Connected to DB.");

        const volumes = await Volume.find({
            'chapters.pages.mediaData.media.DescriptionUpdateRequired': true
        }).populate('series');

        console.log(`Volumes found: ${volumes.length}`);
        
        volumes.forEach((v, i) => {
            console.log(`[${i}] Volume: ${v.volumePath}`);
            console.log(`    Series Object: ${v.series ? 'Linked (' + v.series.title + ')' : 'NULL'}`);
            console.log(`    Folder Name: ${v.series ? v.series.folderName : 'N/A'}`);
        });

    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
}

testQuery();