const mongoose = require('../services/db');
const path = require('path');
const LibraryRoot = require('../models/LibraryRoot');

const mongoDbURI = 'mongodb://localhost:27017/VeilSite';

async function init() {
    try {
        await mongoose.connect(mongoDbURI);
        console.log('Connected to MongoDB');

        const externalPath = 'E:\Comic Series';
        
        let root = await LibraryRoot.findOne({ path: externalPath });
        
        if (!root) {
            root = new LibraryRoot({
                name: 'Main Comic Series',
                path: externalPath,
                isActive: true
            });
            await root.save();
            console.log('Added External Library Root:', externalPath);
        } else {
            console.log('External Library Root already exists:', externalPath);
        }

        process.exit(0);
    } catch (err) {
        console.error('Initialization failed:', err);
        process.exit(1);
    }
}

init();
