// Filter matching, update application, projection and sort.
//
// Only the query features this codebase actually uses are implemented, and that
// is a decision rather than a shortcut: a half-built clone of the whole MongoDB
// query language would be a much larger thing to trust, and every operator it
// supported without a caller would be untested code. An operator that arrives
// here without an implementation THROWS — a silent "matched nothing" would
// surface much later as an empty character list or a lost setting, miles from
// the line that caused it.

const SUPPORTED_FILTER_OPS = new Set([
    '$exists', '$regex', '$options', '$ne', '$in', '$nin', '$gt', '$gte', '$lt', '$lte'
]);
const SUPPORTED_UPDATE_OPS = new Set([
    '$set', '$unset', '$push', '$pull', '$inc', '$addToSet', '$setOnInsert'
]);

/** Reads `a.b.c` out of a document. */
function getPath(doc, dotted) {
    return String(dotted).split('.').reduce((node, key) => (node == null ? undefined : node[key]), doc);
}

/** Writes `a.b.c`, creating the objects along the way. */
function setPath(doc, dotted, value) {
    const parts = String(dotted).split('.');
    const last = parts.pop();
    let node = doc;
    for (const key of parts) {
        if (node[key] === null || typeof node[key] !== 'object') node[key] = {};
        node = node[key];
    }
    node[last] = value;
}

function unsetPath(doc, dotted) {
    const parts = String(dotted).split('.');
    const last = parts.pop();
    let node = doc;
    for (const key of parts) {
        if (node == null || typeof node !== 'object') return;
        node = node[key];
    }
    if (node && typeof node === 'object') delete node[last];
}

/**
 * Value equality, with ids compared as strings.
 *
 * That last part is the whole reason ids are strings here: an id off the URL
 * and an id on a document compare equal without the caller remembering to cast.
 */
function sameValue(a, b) {
    if (a instanceof Date || b instanceof Date) {
        return new Date(a).getTime() === new Date(b).getTime();
    }
    if (a === null || b === null || a === undefined || b === undefined) return a === b;
    if (typeof a === 'object' || typeof b === 'object') {
        return JSON.stringify(a) === JSON.stringify(b);
    }
    return a === b || String(a) === String(b);
}

function matchesCondition(value, condition) {
    if (condition instanceof RegExp) {
        return typeof value === 'string' && condition.test(value);
    }

    const isOperatorObject = condition !== null
        && typeof condition === 'object'
        && !Array.isArray(condition)
        && Object.keys(condition).some(key => key.startsWith('$'));

    if (!isOperatorObject) {
        // A plain value matches an array field if it is one of its members —
        // Mongo's rule, and what makes `{ volumes: someId }` work.
        if (Array.isArray(value) && !Array.isArray(condition)) {
            return value.some(entry => sameValue(entry, condition));
        }
        return sameValue(value, condition);
    }

    for (const [op, operand] of Object.entries(condition)) {
        if (!SUPPORTED_FILTER_OPS.has(op)) {
            throw new Error(`[db] Unsupported query operator ${op}. Implement it in query.js rather than working around it.`);
        }

        switch (op) {
            case '$exists':
                if ((value !== undefined) !== Boolean(operand)) return false;
                break;
            case '$regex': {
                const re = operand instanceof RegExp ? operand : new RegExp(operand, condition.$options || '');
                if (typeof value !== 'string' || !re.test(value)) return false;
                break;
            }
            case '$ne':
                if (sameValue(value, operand)) return false;
                break;
            case '$in':
                if (!operand.some(entry => sameValue(value, entry))) return false;
                break;
            case '$nin':
                if (operand.some(entry => sameValue(value, entry))) return false;
                break;
            case '$gt':  if (!(value > operand)) return false; break;
            case '$gte': if (!(value >= operand)) return false; break;
            case '$lt':  if (!(value < operand)) return false; break;
            case '$lte': if (!(value <= operand)) return false; break;
            case '$options': break; // consumed by $regex
        }
    }

    return true;
}

function matches(doc, filter) {
    if (!filter || typeof filter !== 'object') return true;

    for (const [key, condition] of Object.entries(filter)) {
        if (key === '$or') {
            if (!condition.some(sub => matches(doc, sub))) return false;
            continue;
        }
        if (key === '$and') {
            if (!condition.every(sub => matches(doc, sub))) return false;
            continue;
        }
        if (key.startsWith('$')) {
            throw new Error(`[db] Unsupported top-level query operator ${key}.`);
        }
        if (!matchesCondition(getPath(doc, key), condition)) return false;
    }

    return true;
}

/**
 * Applies an update document in place.
 *
 * An update with no operators replaces the named fields, which is what mongoose
 * does with a plain object — several callers here rely on it.
 */
function applyUpdate(doc, update) {
    if (Array.isArray(update)) {
        throw new Error('[db] Aggregation-pipeline updates are not supported.');
    }

    const operators = Object.keys(update || {}).filter(key => key.startsWith('$'));

    if (!operators.length) {
        for (const [key, value] of Object.entries(update || {})) setPath(doc, key, value);
        return doc;
    }

    for (const op of operators) {
        if (!SUPPORTED_UPDATE_OPS.has(op)) {
            throw new Error(`[db] Unsupported update operator ${op}. Implement it in query.js rather than working around it.`);
        }
    }

    for (const [key, value] of Object.entries(update.$set || {})) setPath(doc, key, value);
    for (const key of Object.keys(update.$unset || {})) unsetPath(doc, key);

    for (const [key, value] of Object.entries(update.$inc || {})) {
        setPath(doc, key, (Number(getPath(doc, key)) || 0) + Number(value));
    }

    for (const [key, value] of Object.entries(update.$push || {})) {
        const existing = getPath(doc, key);
        const target = Array.isArray(existing) ? existing : [];
        if (value && typeof value === 'object' && Array.isArray(value.$each)) target.push(...value.$each);
        else target.push(value);
        setPath(doc, key, target);
    }

    for (const [key, value] of Object.entries(update.$addToSet || {})) {
        const existing = getPath(doc, key);
        const target = Array.isArray(existing) ? existing : [];
        const additions = (value && typeof value === 'object' && Array.isArray(value.$each)) ? value.$each : [value];
        for (const entry of additions) {
            if (!target.some(member => sameValue(member, entry))) target.push(entry);
        }
        setPath(doc, key, target);
    }

    // $pull takes a MATCH, not just a value: GitHubService pulls the entry for
    // one story out of a list of repo objects with `{ story }`.
    for (const [key, value] of Object.entries(update.$pull || {})) {
        const existing = getPath(doc, key);
        if (!Array.isArray(existing)) continue;
        const survives = (entry) => {
            const isPlainMatch = value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof RegExp);
            return isPlainMatch ? !matches(entry, value) : !matchesCondition(entry, value);
        };
        setPath(doc, key, existing.filter(survives));
    }

    return doc;
}

/**
 * Mongo's projection, in both spellings the callers use: a string like
 * `'-password'` or `'_id title index'`, and an object.
 */
function project(doc, projection) {
    if (!projection || !doc) return doc;

    let fields = projection;
    if (typeof projection === 'string') {
        fields = {};
        for (const token of projection.split(/\s+/).filter(Boolean)) {
            if (token.startsWith('-')) fields[token.slice(1)] = 0;
            else fields[token] = 1;
        }
    }

    const entries = Object.entries(fields).filter(([key]) => key !== '_id');
    if (!entries.length) return doc;

    const excluding = entries.every(([, value]) => !value);

    if (excluding) {
        const copy = { ...doc };
        for (const [key] of entries) unsetPath(copy, key);
        if (fields._id === 0) delete copy._id;
        return copy;
    }

    const copy = {};
    if (fields._id !== 0) copy._id = doc._id;
    for (const [key, value] of entries) {
        if (!value) continue;
        const found = getPath(doc, key);
        if (found !== undefined) setPath(copy, key, found);
    }
    return copy;
}

function sortDocs(docs, spec) {
    if (!spec) return docs;

    const keys = Object.entries(spec);
    return docs.sort((a, b) => {
        for (const [key, direction] of keys) {
            const left = getPath(a, key);
            const right = getPath(b, key);
            if (sameValue(left, right)) continue;

            const descending = Number(direction) < 0;

            // Missing values sort first ascending, as they do in Mongo.
            if (left === undefined || left === null) return descending ? 1 : -1;
            if (right === undefined || right === null) return descending ? -1 : 1;

            const comparison = (typeof left === 'string' && typeof right === 'string')
                ? left.localeCompare(right)
                : (left < right ? -1 : 1);

            return descending ? -comparison : comparison;
        }
        return 0;
    });
}

module.exports = {
    getPath, setPath, unsetPath,
    matches, matchesCondition, applyUpdate,
    project, sortDocs, sameValue
};
