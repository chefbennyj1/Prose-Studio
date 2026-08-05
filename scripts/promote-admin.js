// Lock-out recovery: promote an existing account to admin.
//
//   node scripts/promote-admin.js you@example.com
//
// The first admin is made by the setup wizard at /setup, which is reachable
// only while the users collection is empty. Once it isn't, this is the way back
// in — if the last admin's role gets clobbered, or someone needs the rights
// that the dashboard's Accounts section can only grant from an admin session.

require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../models/User.js');
const { normaliseEmail } = require('../utils/accountValidation.js');

// The same URI the server uses, so this touches the database it reads.
const mongoDbURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/ProseEngine';

async function promote(rawEmail) {
    const email = normaliseEmail(rawEmail);
    if (!email) {
        console.error('Usage: node scripts/promote-admin.js <email>');
        return 1;
    }

    await mongoose.connect(mongoDbURI, { serverSelectionTimeoutMS: 10000 });
    console.log(`Connected to ${mongoDbURI}`);

    const user = await User.findOneAndUpdate({ email }, { role: 'admin' }, { new: true });

    if (!user) {
        const known = await User.find({}, 'email role').lean();
        console.error(`No account found for ${email}.`);
        if (known.length) {
            console.error('Known accounts:');
            for (const u of known) console.error(`  ${u.email} (${u.role})`);
        } else {
            console.error('There are no accounts at all — start the server and open /setup instead.');
        }
        return 1;
    }

    console.log(`${user.username} <${user.email}> is now an admin.`);
    return 0;
}

promote(process.argv[2])
    .then(async code => {
        await mongoose.connection.close().catch(() => {});
        process.exit(code);
    })
    .catch(async err => {
        console.error('Failed:', err.message);
        await mongoose.connection.close().catch(() => {});
        process.exit(1);
    });
