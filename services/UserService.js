const UserModel = require('../models/User.js');
const bcrypt = require('bcryptjs');

async function getUserByEmail(email) {
    return await UserModel.findOne({ email }).select('-password');
}

async function updateUserAvatar(userId, avatarUrl) {
    return await UserModel.findByIdAndUpdate(userId, { avatar: avatarUrl }, { new: true }).select('-password');
}

async function updateUser(userId, email, currentPassword, newPassword) {
    try {
        const user = await UserModel.findById(userId);

        if (!user) {
            return { ok: false, status: 404, message: 'User not found' };
        }

        const passwordMatch = await bcrypt.compare(currentPassword, user.password);
        if (!passwordMatch) {
            return { ok: false, status: 403, message: 'Current password is incorrect' };
        }

        if (email !== user.email) {
            const existing = await UserModel.findOne({ email });
            if (existing) {
                return { ok: false, status: 409, message: 'Email already in use' };
            }
            user.email = email;
        }

        if (newPassword && newPassword.length) {
            user.password = await bcrypt.hash(newPassword, 12);

            // The data folder is locked with this password too, so changing it
            // in one place and not the other would leave the writer with an
            // account they can sign into and a folder it no longer opens.
            // Rewraps one small key; the encrypted files are not touched.
            const Vault = require('./config/Vault.js');
            const rewrapped = await Vault.changePassword(currentPassword, newPassword);
            if (!rewrapped) {
                // The account record was already saved above in the normal path,
                // so enrol the new password rather than leaving it half-changed.
                await Vault.addPassword(newPassword);
            }
        }

        await user.save();
        return { ok: true, user };

    } catch (err) {
        console.error(err);
        return { ok: false, status: 500, message: 'Error updating account.' };
    }
}

module.exports = { getUserByEmail, updateUser, updateUserAvatar };