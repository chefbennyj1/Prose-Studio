const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const AccountRequest = require('../models/AccountRequest.js');
const UserModel = require('../models/User.js');

// Shared with the first-run wizard, which creates the admin these routes can't.
const { validateAccountFields: validateRequestBody, normaliseEmail } = require('../utils/accountValidation.js');

// --- POST /accounts/request (public) ---
exports.requestAccount = async (req, res) => {
    const { username, email, password, confirmPassword } = req.body;

    const error = validateRequestBody({ username, email, password, confirmPassword });
    if (error) return res.status(400).json({ ok: false, message: error });

    const clean = { username: username.trim(), email: normaliseEmail(email) };

    try {
        const existingUser = await UserModel.findOne({ email: clean.email });
        if (existingUser) {
            return res.status(409).json({ ok: false, message: 'An account with that email already exists.' });
        }

        const existingRequest = await AccountRequest.findOne({ email: clean.email, status: 'pending' });
        if (existingRequest) {
            return res.status(409).json({ ok: false, message: 'A pending request for that email already exists.' });
        }

        const hashedPassword = await bcrypt.hash(password, 12);

        await AccountRequest.create({
            username: clean.username,
            email: clean.email,
            password: hashedPassword
        });

        return res.json({ ok: true, message: 'Your request has been submitted. An admin will review it shortly.' });
    } catch (err) {
        console.error('[AccountsController] requestAccount error:', err);
        return res.status(500).json({ ok: false, message: 'Server error. Please try again.' });
    }
};

// --- GET /accounts/requests (admin only) ---
exports.getRequests = async (req, res) => {
    try {
        const requests = await AccountRequest.find({ status: 'pending' }).sort({ createdAt: -1 }).lean();
        return res.json({ ok: true, requests });
    } catch (err) {
        console.error('[AccountsController] getRequests error:', err);
        return res.status(500).json({ ok: false, message: 'Server error.' });
    }
};

// --- GET /accounts/users (admin only) ---
exports.getUsers = async (req, res) => {
    try {
        const users = await UserModel.find({}, 'username email role createdAt').sort({ createdAt: -1 }).lean();
        return res.json({ ok: true, users });
    } catch (err) {
        console.error('[AccountsController] getUsers error:', err);
        return res.status(500).json({ ok: false, message: 'Server error.' });
    }
};

// --- POST /accounts/create (admin only) ---
exports.createAccount = async (req, res) => {
    const { username, email, password, role } = req.body;

    const error = validateRequestBody({ username, email, password });
    if (error) return res.status(400).json({ ok: false, message: error });

    const allowedRoles = ['basic', 'moderator', 'admin'];
    const assignedRole = allowedRoles.includes(role) ? role : 'basic';
    const clean = { username: username.trim(), email: normaliseEmail(email) };

    try {
        const existing = await UserModel.findOne({ email: clean.email });
        if (existing) {
            return res.status(409).json({ ok: false, message: 'An account with that email already exists.' });
        }

        const hashedPassword = await bcrypt.hash(password, 12);

        const user = await UserModel.create({
            username: clean.username,
            email: clean.email,
            password: hashedPassword,
            role: assignedRole
        });

        return res.json({ ok: true, message: `Account created for ${clean.username}.`, userId: user._id });
    } catch (err) {
        console.error('[AccountsController] createAccount error:', err);
        return res.status(500).json({ ok: false, message: 'Server error.' });
    }
};

// --- POST /accounts/approve/:requestId (admin only) ---
exports.approveRequest = async (req, res) => {
    const { requestId } = req.params;

    if (!mongoose.isValidObjectId(requestId)) {
        return res.status(400).json({ ok: false, message: 'Invalid request ID.' });
    }

    try {
        const request = await AccountRequest.findById(requestId);
        if (!request || request.status !== 'pending') {
            return res.status(404).json({ ok: false, message: 'Pending request not found.' });
        }

        const existing = await UserModel.findOne({ email: request.email });
        if (existing) {
            await AccountRequest.findByIdAndUpdate(requestId, { status: 'approved' });
            return res.status(409).json({ ok: false, message: 'An account with that email already exists.' });
        }

        await UserModel.create({
            username: request.username,
            email: request.email,
            password: request.password,
            role: 'basic'
        });

        await AccountRequest.findByIdAndUpdate(requestId, { status: 'approved' });

        return res.json({ ok: true, message: `Account approved for ${request.username}.` });
    } catch (err) {
        console.error('[AccountsController] approveRequest error:', err);
        return res.status(500).json({ ok: false, message: 'Server error.' });
    }
};

// --- POST /accounts/deny/:requestId (admin only) ---
exports.denyRequest = async (req, res) => {
    const { requestId } = req.params;

    if (!mongoose.isValidObjectId(requestId)) {
        return res.status(400).json({ ok: false, message: 'Invalid request ID.' });
    }

    try {
        const request = await AccountRequest.findOneAndUpdate(
            { _id: requestId, status: 'pending' },
            { status: 'denied' }
        );
        if (!request) {
            return res.status(404).json({ ok: false, message: 'Pending request not found.' });
        }
        return res.json({ ok: true, message: `Request from ${request.email} denied.` });
    } catch (err) {
        console.error('[AccountsController] denyRequest error:', err);
        return res.status(500).json({ ok: false, message: 'Server error.' });
    }
};

// --- DELETE /accounts/delete/:userId (admin only) ---
exports.deleteAccount = async (req, res) => {
    const { userId } = req.params;

    if (!mongoose.isValidObjectId(userId)) {
        return res.status(400).json({ ok: false, message: 'Invalid user ID.' });
    }

    if (req.session.userId && req.session.userId.toString() === userId) {
        return res.status(400).json({ ok: false, message: 'You cannot delete your own account.' });
    }

    try {
        const user = await UserModel.findById(userId);
        if (!user) return res.status(404).json({ ok: false, message: 'User not found.' });

        if (user.role === 'admin') {
            const adminCount = await UserModel.countDocuments({ role: 'admin' });
            if (adminCount <= 1) {
                return res.status(400).json({ ok: false, message: 'Cannot delete the last admin account.' });
            }
        }

        await UserModel.findByIdAndDelete(userId);
        return res.json({ ok: true, message: `Account for ${user.username} deleted.` });
    } catch (err) {
        console.error('[AccountsController] deleteAccount error:', err);
        return res.status(500).json({ ok: false, message: 'Server error.' });
    }
};
