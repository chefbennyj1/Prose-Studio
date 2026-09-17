const mongoose = require('../services/db');
const fs = require('fs').promises;
const path = require('path');

// Models
const Series = require('../models/Series');
const Volume = require('../models/Volume');
const Character = require('../models/Character');

async function runBackup() {
    console.log("Starting Database Backup...");
    
    try {
        await mongoose.connect('mongodb://localhost:27017/VeilSite');
        console.log("Connected to MongoDB.");

        const [series, volumes, characters] = await Promise.all([
            Series.find({}).lean(),
            Volume.find({}).lean(),
            Character.find({}).lean()
        ]);

        const backupData = {
            timestamp: new Date().toISOString(),
            series,
            volumes,
            characters
        };

        const backupPath = path.join(__dirname, '..', 'db_backup.json');
        await fs.writeFile(backupPath, JSON.stringify(backupData, null, 2));

        console.log(`Backup successful! Saved to: ${backupPath}`);
        console.log(`  - Series: ${series.length}`);
        console.log(`  - Volumes: ${volumes.length}`);
        console.log(`  - Characters: ${characters.length}`);

    } catch (err) {
        console.error("Backup Failed:", err);
    } finally {
        await mongoose.disconnect();
        process.exit(0);
    }
}

runBackup();
