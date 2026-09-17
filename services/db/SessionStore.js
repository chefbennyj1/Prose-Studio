// Login sessions, held in memory for the life of the process.
//
// This replaced connect-mongo, which kept sessions in MongoDB — the last thing
// still forcing a database server to exist. It was briefly a file store, and
// that was wrong once the data folder became password-unlocked: a stored
// session exists to spare someone from signing in again, and there is nothing
// to spare them from any more. The app cannot read ANYTHING until a password
// unlocks it, and typing that password is the sign-in. A session that outlived
// the process would be a key to a door that is already bolted.
//
// So sessions live and die with the process, which also means:
//
//   - no session file to leak a logged-in session to whoever finds the folder
//   - closing the app really does sign you out, which is what a writer on a
//     shared machine would assume it does
//
// Expired sessions are swept hourly so a long-running instance does not hold
// them forever — the leak that express-session's own MemoryStore warns about.

const { Store } = require('express-session');

const SWEEP_INTERVAL = 60 * 60 * 1000; // hourly

class MemorySessionStore extends Store {
    constructor(options = {}) {
        super(options);
        this.ttl = options.ttl || 24 * 60 * 60; // seconds, matching the cookie
        this.sessions = new Map();

        // unref so a pending sweep never holds the process open on shutdown.
        this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL);
        if (this.sweeper.unref) this.sweeper.unref();
    }

    expiresAt(session) {
        const cookieExpiry = session?.cookie?.expires;
        if (cookieExpiry) return new Date(cookieExpiry).getTime();
        return Date.now() + this.ttl * 1000;
    }

    get(sid, callback) {
        const record = this.sessions.get(sid);

        if (!record) return callback(null, null);
        if (record.expires <= Date.now()) {
            this.sessions.delete(sid);
            return callback(null, null);
        }

        try {
            return callback(null, JSON.parse(record.session));
        } catch (err) {
            return callback(err);
        }
    }

    set(sid, session, callback = () => {}) {
        try {
            this.sessions.set(sid, {
                session: JSON.stringify(session),
                expires: this.expiresAt(session)
            });
            callback(null);
        } catch (err) {
            callback(err);
        }
    }

    // A rolling session only needs its expiry moved, and touch fires on every
    // request — re-serialising the whole payload each time would be the hot path.
    touch(sid, session, callback = () => {}) {
        const record = this.sessions.get(sid);
        if (record) record.expires = this.expiresAt(session);
        callback(null);
    }

    destroy(sid, callback = () => {}) {
        this.sessions.delete(sid);
        callback(null);
    }

    clear(callback = () => {}) {
        this.sessions.clear();
        callback(null);
    }

    length(callback = () => {}) {
        callback(null, this.sessions.size);
    }

    all(callback = () => {}) {
        const live = [];
        for (const record of this.sessions.values()) {
            if (record.expires > Date.now()) live.push(JSON.parse(record.session));
        }
        callback(null, live);
    }

    sweep() {
        const now = Date.now();
        for (const [sid, record] of this.sessions) {
            if (record.expires <= now) this.sessions.delete(sid);
        }
    }
}

module.exports = MemorySessionStore;
