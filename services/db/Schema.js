// Schemas: defaults, required fields, enums, uniqueness — and secrets.
//
// The shape of a definition is mongoose's, because every model in this repo is
// already written in it and rewriting eight schemas to a new dialect would be
// change for its own sake. What is NOT mongoose's is `secret: true`.
//
// ## Why `secret: true` exists
//
// The Gemini API key and the GitHub token are encrypted before they are stored,
// and they always were — but only because each caller remembers to call
// `encrypt()` first. Nothing checked. A new code path that assigned the key
// directly would write it in the clear and no test, type or reviewer would
// necessarily catch it, because a plaintext key looks exactly like a working
// one to every other line of code.
//
// That was survivable when the documents lived in a database. They now live in
// a JSON file in the user's app-data folder — a file that gets synced to
// Dropbox, swept into backups and pasted into support threads. So the rule is
// enforced where it cannot be forgotten: a field marked `secret` REFUSES to be
// written unless the value is already ciphertext. Forgetting to encrypt is now
// a loud error at the moment of the write, instead of a key sitting in a file.
//
// The files ARE encrypted as a whole as well (services/db/fileCrypto.js), and
// this layer is not made redundant by that. The file encryption protects the
// file; this protects the VALUE — which is the thing that is still worth
// something after it leaves the disk, in a log line, a crash dump, or a
// decrypted document pasted into a support thread. A live credential deserves
// to be the one field that is unreadable even to someone holding the open file.

const ObjectId = require('./ObjectId');

/** Marker for id-typed fields. Ids are strings; this only records intent. */
class ObjectIdType {}

class Schema {
    constructor(definition = {}, options = {}) {
        this.definition = definition;
        this.options = options;
    }

    /** Mongoose lets callers declare indexes separately; we have no indexes. */
    index() { return this; }
    pre() { return this; }
    post() { return this; }
    virtual() { return { get() {}, set() {} }; }
}

Schema.Types = { ObjectId: ObjectIdType, Mixed: Object, String, Number, Boolean, Date, Array };

const TYPE_TOKENS = new Set([String, Number, Boolean, Date, Object, Array, ObjectIdType]);

function isTypeToken(token) {
    return TYPE_TOKENS.has(token) || Array.isArray(token) || token instanceof Schema;
}

/**
 * Is this `{ type: String, default: '' }` (a field), or `{ storyRoot: {...} }`
 * (a nested object of fields)? The presence of a `type` key holding an actual
 * type is what separates them, which is mongoose's own rule.
 */
function isFieldDescriptor(node) {
    return node !== null
        && typeof node === 'object'
        && !Array.isArray(node)
        && !(node instanceof Schema)
        && 'type' in node
        && isTypeToken(node.type);
}

/** The definition object for an array's elements, or null for a plain array. */
function elementDefinition(element) {
    if (element instanceof Schema) return element.definition;
    if (isFieldDescriptor(element)) return null;
    if (element !== null && typeof element === 'object' && !Array.isArray(element)) return element;
    return null;
}

function cloneDefault(value) {
    if (typeof value === 'function') return value();
    if (value === null || typeof value !== 'object') return value;
    return JSON.parse(JSON.stringify(value));
}

function castValue(value, type) {
    if (value === undefined || value === null) return value;

    if (type === String || type === ObjectIdType) return typeof value === 'string' ? value : String(value);
    if (type === Number) {
        const asNumber = Number(value);
        return Number.isNaN(asNumber) ? value : asNumber;
    }
    if (type === Boolean) return Boolean(value);
    if (type === Date) return value instanceof Date ? value : new Date(value);
    return value;
}

/**
 * Fills in every default the document has not set, in place and recursively, so
 * a document saved from a partial object still has the shape the readers expect
 * (`doc.storage.storyRoot`, `doc.github.repos`).
 */
function applyDefaults(target, definition) {
    for (const [key, node] of Object.entries(definition)) {
        if (key === '_id') continue;

        if (isFieldDescriptor(node)) {
            if (target[key] === undefined && 'default' in node) {
                target[key] = cloneDefault(node.default);
            }
            if (typeof target[key] === 'string' && node.trim) target[key] = target[key].trim();
            if (target[key] !== undefined) target[key] = castValue(target[key], node.type);
            continue;
        }

        if (Array.isArray(node)) {
            if (target[key] === undefined) target[key] = [];
            const elementDef = elementDefinition(node[0]);
            if (elementDef && Array.isArray(target[key])) {
                for (const entry of target[key]) {
                    if (entry && typeof entry === 'object') {
                        if (node[0] instanceof Schema && node[0].definition._id !== false && entry._id === undefined) {
                            entry._id = ObjectId();
                        }
                        applyDefaults(entry, elementDef);
                    }
                }
            }
            continue;
        }

        if (node instanceof Schema) {
            if (target[key] === undefined) target[key] = {};
            applyDefaults(target[key], node.definition);
            continue;
        }

        if (isTypeToken(node)) {
            // Shorthand: `title: String`. No default to apply.
            if (target[key] !== undefined) target[key] = castValue(target[key], node);
            continue;
        }

        if (node !== null && typeof node === 'object') {
            if (target[key] === undefined || target[key] === null || typeof target[key] !== 'object') target[key] = {};
            applyDefaults(target[key], node);
        }
    }

    return target;
}

const CIPHERTEXT = /^[0-9a-f]{32}:[0-9a-f]+$/i;

/**
 * Walks a document against its definition, collecting every reason it must not
 * be saved. Returns an array of messages; empty means valid.
 */
function validate(doc, definition, prefix = '') {
    const errors = [];

    for (const [key, node] of Object.entries(definition)) {
        if (key === '_id') continue;

        const value = doc ? doc[key] : undefined;
        const path = prefix ? `${prefix}.${key}` : key;

        if (isFieldDescriptor(node)) {
            const empty = value === undefined || value === null || value === '';

            if (node.required && empty) {
                errors.push(`${path} is required`);
                continue;
            }
            if (empty) continue;

            if (node.enum && !node.enum.includes(value)) {
                errors.push(`${path} must be one of ${node.enum.join(', ')}`);
            }
            if (node.min !== undefined && Number(value) < node.min) {
                errors.push(`${path} must be at least ${node.min}`);
            }
            if (node.max !== undefined && Number(value) > node.max) {
                errors.push(`${path} must be at most ${node.max}`);
            }
            if (node.validate && typeof node.validate.validator === 'function' && !node.validate.validator(value)) {
                errors.push(node.validate.message || `${path} failed validation`);
            }

            // The guard this whole file exists for.
            if (node.secret && typeof value === 'string' && value && !CIPHERTEXT.test(value)) {
                errors.push(
                    `${path} is a secret and was about to be stored in the clear. ` +
                    `Pass it through encrypt() from utils/encryption.js before assigning it.`
                );
            }
            continue;
        }

        if (Array.isArray(node)) {
            const elementDef = elementDefinition(node[0]);
            if (elementDef && Array.isArray(value)) {
                value.forEach((entry, index) => {
                    errors.push(...validate(entry, elementDef, `${path}.${index}`));
                });
            }
            continue;
        }

        if (node instanceof Schema) {
            errors.push(...validate(value, node.definition, path));
            continue;
        }

        if (!isTypeToken(node) && node !== null && typeof node === 'object') {
            errors.push(...validate(value, node, path));
        }
    }

    return errors;
}

/** Every dotted path declared `unique: true`. */
function uniquePaths(definition, prefix = '') {
    const paths = [];

    for (const [key, node] of Object.entries(definition)) {
        const path = prefix ? `${prefix}.${key}` : key;

        if (isFieldDescriptor(node)) {
            if (node.unique) paths.push(path);
            continue;
        }
        if (node instanceof Schema) {
            paths.push(...uniquePaths(node.definition, path));
            continue;
        }
        if (!Array.isArray(node) && !isTypeToken(node) && node !== null && typeof node === 'object') {
            paths.push(...uniquePaths(node, path));
        }
    }

    return paths;
}

/** Dotted path -> referenced model name, for populate(). */
function refPaths(definition, prefix = '') {
    const refs = {};

    for (const [key, node] of Object.entries(definition)) {
        const path = prefix ? `${prefix}.${key}` : key;

        if (isFieldDescriptor(node)) {
            if (node.ref) refs[path] = { model: node.ref, many: Array.isArray(node.type) };
            continue;
        }
        if (Array.isArray(node)) {
            if (isFieldDescriptor(node[0]) && node[0].ref) refs[path] = { model: node[0].ref, many: true };
            continue;
        }
        if (node instanceof Schema) {
            Object.assign(refs, refPaths(node.definition, path));
            continue;
        }
        if (!isTypeToken(node) && node !== null && typeof node === 'object') {
            Object.assign(refs, refPaths(node, path));
        }
    }

    return refs;
}

module.exports = Schema;
module.exports.Schema = Schema;
module.exports.ObjectIdType = ObjectIdType;
module.exports.applyDefaults = applyDefaults;
module.exports.validate = validate;
module.exports.uniquePaths = uniquePaths;
module.exports.refPaths = refPaths;
module.exports.isFieldDescriptor = isFieldDescriptor;
