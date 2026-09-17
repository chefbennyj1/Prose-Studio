const db = require('../services/db');

const accountRequestSchema = new db.Schema({
    username: { type: String, required: true },
    email:    { type: String, required: true },
    password: { type: String, required: true },
    status:   { type: String, enum: ['pending', 'approved', 'denied'], default: 'pending' }
}, { timestamps: true });

module.exports = db.model('AccountRequest', accountRequestSchema);
