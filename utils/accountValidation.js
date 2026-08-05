// Shared account field rules. The setup wizard creates the first admin and the
// dashboard creates everyone else; both have to agree on what a valid account
// looks like, or the first login is the one that finds the disagreement.

const USERNAME_RE = /^[a-zA-Z0-9 _-]{3,50}$/;
const EMAIL_RE    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Returns an error message, or null when the fields are acceptable. */
function validateAccountFields({ username, email, password, confirmPassword }) {
    if (!username || !USERNAME_RE.test(username.trim())) {
        return 'Username must be 3–50 characters (letters, numbers, spaces, hyphens, underscores).';
    }
    if (!email || !EMAIL_RE.test(email.trim())) {
        return 'A valid email address is required.';
    }
    if (!password || password.length < 8 || password.length > 128) {
        return 'Password must be 8–128 characters.';
    }
    if (confirmPassword !== undefined && password !== confirmPassword) {
        return 'Passwords do not match.';
    }
    return null;
}

/**
 * Emails are stored lowercase everywhere. Login looks accounts up by exact
 * match, so a mixed-case address at one end and a lowercased one at the other
 * reads as "invalid email or password" with no way to tell why.
 */
function normaliseEmail(email) {
    return String(email || '').trim().toLowerCase();
}

module.exports = { validateAccountFields, normaliseEmail, USERNAME_RE, EMAIL_RE };
