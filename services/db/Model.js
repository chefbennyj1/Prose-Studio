// Models and queries — the surface the rest of the app already calls.
//
// Every method here exists because something in this repo calls it. The list
// was taken from the code rather than from memory of what mongoose offers, so
// the shape is small on purpose: find/findOne/findById, the findAndUpdate
// family, create, updateOne/updateMany, deleteOne/deleteMany, countDocuments,
// and on the documents themselves, save() and toObject().
//
// Queries are thenables rather than promises, which is what lets the existing
// `await Model.find({}).sort({ title: 1 }).populate('libraryRoot').lean()`
// keep working untouched: nothing runs until something awaits.

const store = require('./Store');
const ObjectId = require('./ObjectId');
const {
    matches, applyUpdate, project, sortDocs, getPath, sameValue
} = require('./query');
const {
    applyDefaults, validate, uniquePaths, refPaths
} = require('./Schema');

/** Every model built so far, so populate() can find the one it needs. */
const registry = new Map();

/**
 * Collection names, near enough to mongoose's to be unsurprising.
 *
 * Only the cases this repo produces are handled — the point is filenames a
 * person can recognise in their app-data folder, so `Series` must not become
 * `seriess.json` and `GlobalSettings` must not become `globalsettingss.json`.
 */
function pluralize(name) {
    const lower = name.toLowerCase();
    if (lower.endsWith('s')) return lower;
    if (lower.endsWith('y') && !/[aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`;
    if (/(ch|sh|x|z)$/.test(lower)) return `${lower}es`;
    return `${lower}s`;
}

class ValidationError extends Error {
    constructor(model, errors) {
        super(`${model} validation failed: ${errors.join('; ')}`);
        this.name = 'ValidationError';
        this.errors = errors;
    }
}

/**
 * A deep copy with the document's own methods left behind.
 *
 * The spread is load-bearing: documents carry a non-enumerable `toJSON`, and
 * JSON.stringify calls it, which called clone, which called stringify. Copying
 * into a bare object first means stringify sees plain data and stops.
 */
function clone(value) {
    if (value === undefined || value === null) return value;
    const plain = (typeof value === 'object' && !Array.isArray(value)) ? { ...value } : value;
    return JSON.parse(JSON.stringify(plain));
}

class Query {
    /** @param {() => ({ list: object[], single: boolean })} source */
    constructor(model, source) {
        this.model = model;
        this.source = source;
        this._projection = null;
        this._sort = null;
        this._lean = false;
        this._populate = [];
        this._limit = null;
        this._skip = 0;
    }

    select(projection) { this._projection = projection; return this; }
    sort(spec) { this._sort = spec; return this; }
    lean() { this._lean = true; return this; }
    limit(count) { this._limit = count; return this; }
    skip(count) { this._skip = count; return this; }
    populate(path) { this._populate.push(typeof path === 'string' ? path : path.path); return this; }

    async exec() {
        const { list, single } = this.source();
        let docs = list.map(clone);

        if (this._sort) docs = sortDocs(docs, this._sort);
        if (this._skip) docs = docs.slice(this._skip);
        if (this._limit !== null) docs = docs.slice(0, this._limit);

        for (const path of this._populate) {
            for (const doc of docs) populateInto(this.model, doc, path);
        }

        if (this._projection) docs = docs.map(doc => project(doc, this._projection));

        const result = this._lean ? docs : docs.map(doc => this.model.hydrate(doc));

        return single ? (result[0] ?? null) : result;
    }

    then(onFulfilled, onRejected) { return this.exec().then(onFulfilled, onRejected); }
    catch(onRejected) { return this.exec().catch(onRejected); }
    finally(handler) { return this.exec().finally(handler); }
}

/**
 * Replaces an id (or an array of ids) with the document it points at.
 *
 * A reference that no longer resolves becomes null rather than throwing: a
 * deleted library root should leave a series listable, not break the listing.
 */
function populateInto(model, doc, path) {
    const ref = model.refs[path];
    if (!ref || !doc) return;

    const target = registry.get(ref.model);
    if (!target) return;

    const value = getPath(doc, path);
    if (value === undefined || value === null) return;

    const lookup = (id) => {
        const found = target.collection().load().find(entry => sameValue(entry._id, id));
        return found ? clone(found) : null;
    };

    doc[path] = Array.isArray(value) ? value.map(lookup).filter(Boolean) : lookup(value);
}

class ModelCore {
    constructor(name, schema, collectionName) {
        this.modelName = name;
        this.schema = schema;
        this.collectionName = collectionName || pluralize(name);
        this.uniques = uniquePaths(schema.definition);
        this.refs = refPaths(schema.definition);
    }

    collection() { return store.collection(this.collectionName); }

    /** Turns stored data into a document with save() on it. */
    hydrate(raw) {
        const doc = { ...raw };
        const model = this;

        Object.defineProperty(doc, 'save', {
            enumerable: false,
            value: async function save() { return model.persist(this); }
        });
        Object.defineProperty(doc, 'toObject', {
            enumerable: false,
            value: function toObject() { return clone({ ...this }); }
        });
        Object.defineProperty(doc, 'toJSON', {
            enumerable: false,
            value: function toJSON() { return { ...this }; }
        });
        // Mongoose needs telling when a Mixed field changed in place; we always
        // write the whole document, so there is nothing to mark.
        Object.defineProperty(doc, 'markModified', {
            enumerable: false,
            value: function markModified() {}
        });
        Object.defineProperty(doc, 'id', {
            enumerable: false,
            configurable: true,
            get() { return this._id; }
        });

        return doc;
    }

    /** `new Model({...})`: a document that exists only in memory until saved. */
    build(data = {}) {
        const raw = clone(data) || {};
        if (!raw._id) raw._id = ObjectId();
        applyDefaults(raw, this.schema.definition);
        return this.hydrate(raw);
    }

    /** Validates, stamps, enforces uniqueness, writes, and waits for the disk. */
    async persist(doc) {
        const raw = clone(doc);
        if (!raw._id) raw._id = ObjectId();

        applyDefaults(raw, this.schema.definition);

        const errors = validate(raw, this.schema.definition);
        if (errors.length) throw new ValidationError(this.modelName, errors);

        const collection = this.collection();
        const docs = collection.load();
        const index = docs.findIndex(entry => sameValue(entry._id, raw._id));

        for (const path of this.uniques) {
            const value = getPath(raw, path);
            if (value === undefined || value === null || value === '') continue;
            const clash = docs.some((entry, position) =>
                position !== index && sameValue(getPath(entry, path), value));
            if (clash) {
                throw new ValidationError(this.modelName, [`${path} must be unique ('${value}' already exists)`]);
            }
        }

        if (this.schema.options.timestamps) {
            const now = new Date().toISOString();
            if (index < 0 && !raw.createdAt) raw.createdAt = now;
            raw.updatedAt = now;
        }

        if (index < 0) docs.push(raw);
        else docs[index] = raw;

        await collection.flush();

        // Reflect anything applyDefaults or the stamps added back onto the
        // caller's document, so `doc.createdAt` is set after `await doc.save()`.
        Object.assign(doc, raw);
        return doc;
    }

    // --- Reads ---------------------------------------------------------------

    find(filter = {}, projection = null) {
        const query = new Query(this, () => ({
            list: this.collection().load().filter(doc => matches(doc, filter)),
            single: false
        }));
        if (projection) query.select(projection);
        return query;
    }

    findOne(filter = {}, projection = null) {
        const query = new Query(this, () => {
            const found = this.collection().load().find(doc => matches(doc, filter));
            return { list: found ? [found] : [], single: true };
        });
        if (projection) query.select(projection);
        return query;
    }

    findById(id, projection = null) {
        if (id === undefined || id === null) {
            return new Query(this, () => ({ list: [], single: true }));
        }
        return this.findOne({ _id: id }, projection);
    }

    async countDocuments(filter = {}) {
        return this.collection().load().filter(doc => matches(doc, filter)).length;
    }

    /** Mongo's fast, approximate count. Here it is the exact one. */
    async estimatedDocumentCount() {
        return this.collection().load().length;
    }

    async exists(filter = {}) {
        const found = this.collection().load().find(doc => matches(doc, filter));
        return found ? { _id: found._id } : null;
    }

    async distinct(field, filter = {}) {
        const values = this.collection().load()
            .filter(doc => matches(doc, filter))
            .map(doc => getPath(doc, field));
        return [...new Set(values.flat())];
    }

    // --- Writes --------------------------------------------------------------

    async create(data) {
        if (Array.isArray(data)) return Promise.all(data.map(entry => this.create(entry)));
        const doc = this.build(data);
        await this.persist(doc);
        return doc;
    }

    async insertMany(list) { return this.create(list); }

    /**
     * The shared path behind updateOne/updateMany/findOneAndUpdate.
     * Returns the documents it touched, already saved.
     */
    async applyToMatching(filter, update, options = {}, limit = Infinity) {
        const docs = this.collection().load();
        const targets = docs.filter(doc => matches(doc, filter)).slice(0, limit);

        if (!targets.length && options.upsert) {
            // Mongo seeds an upsert from the filter's equality fields, which is
            // what makes `findOneAndUpdate({ key: 'main' }, ...)` produce a
            // document that still has `key: 'main'` on it.
            const seed = {};
            for (const [key, value] of Object.entries(filter || {})) {
                if (!key.startsWith('$') && (value === null || typeof value !== 'object')) seed[key] = value;
            }
            const created = this.build(seed);
            applyUpdate(created, update);
            if (update && update.$setOnInsert) applyUpdate(created, { $set: update.$setOnInsert });
            await this.persist(created);
            return { touched: [created], upserted: true };
        }

        const saved = [];
        for (const target of targets) {
            const working = this.hydrate(clone(target));
            applyUpdate(working, update);
            await this.persist(working);
            saved.push(working);
        }

        return { touched: saved, upserted: false };
    }

    async updateOne(filter, update, options = {}) {
        const { touched, upserted } = await this.applyToMatching(filter, update, options, 1);
        return {
            acknowledged: true,
            matchedCount: upserted ? 0 : touched.length,
            modifiedCount: upserted ? 0 : touched.length,
            upsertedCount: upserted ? 1 : 0,
            upsertedId: upserted ? touched[0]._id : null
        };
    }

    async updateMany(filter, update, options = {}) {
        const { touched } = await this.applyToMatching(filter, update, options);
        return {
            acknowledged: true,
            matchedCount: touched.length,
            modifiedCount: touched.length,
            upsertedCount: 0,
            upsertedId: null
        };
    }

    /**
     * `{ new: true }` returns the updated document, and its absence returns the
     * document as it was. Callers here rely on both.
     */
    findOneAndUpdate(filter, update, options = {}) {
        const before = clone(this.collection().load().find(doc => matches(doc, filter)));
        const pending = this.applyToMatching(filter, update, options, 1);

        const query = new Query(this, () => ({ list: [], single: true }));
        query.exec = async () => {
            const { touched } = await pending;
            if (!touched.length) return null;
            const result = (options.new === false || options.new === undefined) && before
                ? this.hydrate(before)
                : touched[0];
            return query._lean ? clone(result) : result;
        };
        return query;
    }

    findByIdAndUpdate(id, update, options = {}) {
        return this.findOneAndUpdate({ _id: id }, update, options);
    }

    async deleteOne(filter = {}) {
        const docs = this.collection().load();
        const index = docs.findIndex(doc => matches(doc, filter));
        if (index < 0) return { acknowledged: true, deletedCount: 0 };
        docs.splice(index, 1);
        await this.collection().flush();
        return { acknowledged: true, deletedCount: 1 };
    }

    async deleteMany(filter = {}) {
        const docs = this.collection().load();
        const keep = docs.filter(doc => !matches(doc, filter));
        const removed = docs.length - keep.length;
        if (!removed) return { acknowledged: true, deletedCount: 0 };
        docs.length = 0;
        docs.push(...keep);
        await this.collection().flush();
        return { acknowledged: true, deletedCount: removed };
    }

    findOneAndDelete(filter = {}) {
        const query = new Query(this, () => ({ list: [], single: true }));
        query.exec = async () => {
            const docs = this.collection().load();
            const index = docs.findIndex(doc => matches(doc, filter));
            if (index < 0) return null;
            const [removed] = docs.splice(index, 1);
            await this.collection().flush();
            return query._lean ? removed : this.hydrate(removed);
        };
        return query;
    }

    findByIdAndDelete(id) { return this.findOneAndDelete({ _id: id }); }

    /** Indexes are a Mongo concern; uniqueness is enforced on write instead. */
    async createIndexes() { return []; }
    async syncIndexes() { return []; }
}

/**
 * Builds the object the models export.
 *
 * It has to be a FUNCTION rather than an instance, because the callers use both
 * halves of mongoose's API on the same object: `User.findOne(...)` and
 * `new User({...})`. A constructor that returns an object hands back that
 * object, which is what makes `new User({...})` produce a document.
 */
function createModel(name, schema, collectionName) {
    const core = new ModelCore(name, schema, collectionName);

    function ProseModel(data) {
        return core.build(data);
    }

    for (const key of Object.getOwnPropertyNames(ModelCore.prototype)) {
        if (key === 'constructor') continue;
        ProseModel[key] = core[key].bind(core);
    }

    ProseModel.modelName = core.modelName;
    ProseModel.schema = schema;
    ProseModel.collectionName = core.collectionName;
    ProseModel.uniques = core.uniques;
    ProseModel.refs = core.refs;
    ProseModel.core = core;

    return ProseModel;
}

module.exports = { ModelCore, createModel, Query, registry, ValidationError };
