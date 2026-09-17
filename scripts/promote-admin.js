// Lock-out recovery: promote an existing account to admin.
//
//   node scripts/promote-admin.js you@example.com
//
// The first admin is made by the setup wizard at /setup, which is reachable
// only while there are no accounts. Once there are, this is the way back in —
// if the last admin's role gets clobbered, or someone needs the rights that the
// dashboard's Accounts section can only grant from an admin session.
//
// It asks for a password, and that is not an extra precaution bolted on: the
// accounts live in an encrypted folder, and a password is the only thing that
// opens it. A script that could change roles without one would be a hole
// straight through everything the encryption is for.

const readline = require('readline');

const db = require('../services/db');
const Vault = require('../services/config/Vault.js');
const Database = require('../services/DatabaseService.js');
const User = require('../models/User.js');
const { normaliseEmail } = require('../utils/accountValidation.js');

/**
 * Reads a password without echoing it.
 *
 * `readline` has no password mode, so the raw terminal is driven directly and
 * restored afterwards — including on Ctrl-C, or the shell is left with echo off
 * and the next thing the person types is invisible.
 */
function askPassword(prompt) {
    return new Promise((resolve, reject) => {
        const { stdin, stdout } = process;

        if (!stdin.isTTY) {
            return reject(new Error('A terminal is required to type a password.'));
        }

        stdout.write(prompt);

        const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
        let entered = '';

        const restore = () => {
            stdin.setRawMode(false);
            stdin.removeListener('data', onData);
            rl.close();
        };

        const onData = (chunk) => {
            const char = chunk.toString('utf8');

            switch (char) {
                case '\r':
                case '\n':
                    stdout.write('\n');
                    restore();
                    return resolve(entered);
                case '': // Ctrl-C
                    stdout.write('\n');
                    restore();
                    return reject(new Error('Cancelled.'));
                case '': // Backspace
                case '\b':
                    entered = entered.slice(0, -1);
                    return;
                default:
                    if (char >= ' ') entered += char;
            }
        };

        stdin.setRawMode(true);
        stdin.resume();
        stdin.on('data', onData);
    });
}

async function promote(rawEmail) {
    const email = normaliseEmail(rawEmail);
    if (!email) {
        console.error('Usage: node scripts/promote-admin.js <email>');
        return 1;
    }

    const opened = await Database.connect();
    if (!opened.ok) {
        console.error(opened.message);
        return 1;
    }

    if (!Vault.exists()) {
        console.error(`No Prose Engine data found in ${Database.directory()}.`);
        console.error('If the app keeps its data elsewhere, set PROSE_DATA_DIR to that folder and try again.');
        return 1;
    }

    const password = await askPassword('Password for any account on this installation: ');

    if (!await Vault.unlock(password)) {
        console.error('That password does not open this data folder.');
        return 1;
    }

    const user = await User.findOne({ email });
    if (!user) {
        console.error(`No account with the email ${email}.`);
        return 1;
    }

    if (user.role === 'admin') {
        console.log(`${user.username} <${user.email}> is already an admin.`);
        return 0;
    }

    const previous = user.role;
    user.role = 'admin';
    await user.save();

    console.log(`${user.username} <${user.email}> promoted from ${previous} to admin.`);
    return 0;
}

(async () => {
    let code = 1;
    try {
        code = await promote(process.argv[2]);
    } catch (err) {
        console.error(err.message);
    } finally {
        await db.connection.close().catch(() => {});
        process.exit(code);
    }
})();
