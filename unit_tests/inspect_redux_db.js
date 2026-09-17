const mongoose = require('../services/db');
const Volume = require('../models/Volume');

async function inspectRedux() {
    try {
        await mongoose.connect('mongodb://localhost:27017/VeilSite');
        const vol = await Volume.findOne({ volumePath: /No_Overflow_Redux/i });
        if (!vol) return console.log("Redux volume not found.");

        const firstPage = vol.chapters[0]?.pages[0];
        console.log("Page 1 Media Data from DB:");
        console.log(JSON.stringify(firstPage.mediaData, null, 2));

    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
}

inspectRedux();