// Document ids, in the shape the rest of the app already expects.
//
// Mongo's ObjectId is an object; these are plain 24-character hex STRINGS, and
// that is deliberate. Half this codebase compares an id from `req.params` (a
// string) against a document's `_id`, and with a real ObjectId that comparison
// is only correct if you remember to wrap it — `String(doc._id) === id`. Every
// place that forgot was a bug waiting for two documents to disagree. A string
// id makes `===` right by default, survives JSON.stringify unchanged, and is
// still accepted by `isValid`, which is all the callers ever asked of it.

const crypto = require('crypto');

// Same layout as Mongo's: 4-byte timestamp, 5-byte random per process, 3-byte
// counter. The timestamp prefix is what makes ids sort roughly by creation,
// which is why `_id` order is a usable fallback sort.
const MACHINE = crypto.randomBytes(5).toString('hex');
let counter = crypto.randomBytes(3).readUIntBE(0, 3);

function ObjectId() {
    const time = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
    counter = (counter + 1) % 0xffffff;
    return time + MACHINE + counter.toString(16).padStart(6, '0');
}

ObjectId.isValid = (value) => {
    if (value === null || value === undefined) return false;
    return /^[0-9a-f]{24}$/i.test(String(value));
};

module.exports = ObjectId;
