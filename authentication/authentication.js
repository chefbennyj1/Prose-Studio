const express = require("express");
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const router = express.Router();

//USER SCHEMA
const UserModel = require('../models/User.js');
const Vault = require('../services/config/Vault.js');
const { normaliseEmail } = require('../utils/accountValidation.js');

// Create a limiter for the login route
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 login requests per 15 minutes
  handler: (req, res) => {
    res.status(429).json({
      ok: false,
      message: 'Too many login attempts. Please try again after 15 minutes.',
      type: 'rate-limit'
    });
  }
});

//LOGIN THE USER
router.post('/login', loginLimiter, async (req, res) => {

  const { email, password, returnTo } = req.body;

  // Only ever return to an internal path ('//' would be protocol-relative)
  const isInternalPath = typeof returnTo === 'string' &&
    returnTo.startsWith('/') && !returnTo.startsWith('//');
  // Default landing is the dashboard: the reader-facing /library went with the
  // comic browser, and logging in used to drop the writer on a 404.
  const destination = isInternalPath ? returnTo : '/dashboard';

  try {
    // Signing in is also UNLOCKING. The account records live inside the
    // encrypted store, so there is nothing to look up until the password has
    // opened it — the password proves itself against the lock before anything
    // is read, and bcrypt below then proves it against this particular account.
    //
    // A wrong password fails here rather than at the bcrypt check, and it must
    // produce the same answer: "invalid email or password", never "that is not
    // the password this folder was locked with", which would tell a stranger
    // they had found a real installation.
    if (!Vault.isUnlocked()) {
      const opened = await Vault.unlock(password);
      if (!opened) {
        if (req.headers.accept && req.headers.accept.includes('application/json')) {
          return res.status(401).json({ ok: false, message: "Invalid email or password" });
        }
        return res.redirect('/login');
      }
    }

    // Accounts are stored with a lowercased email; look up the same way, or a
    // capital letter in the address reads as "invalid email or password".
    const user = await UserModel.findOne({ email: normaliseEmail(email) });

    if (!user) {
      if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.status(401).json({ ok: false, message: "Invalid email or password" });
      }
      return res.redirect('/login');
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.status(401).json({ ok: false, message: "Invalid email or password" });
      }
      return res.redirect('/login');
    }

    // Enrol an account whose password the vault has never seen.
    //
    // Approving a sign-up request copies a bcrypt HASH into the new account —
    // the plaintext was never available, and a hash cannot wrap a key. Such an
    // account passes the check above but could not have opened the lock, so it
    // is enrolled here, the first time its password is proved while the folder
    // is already open. Without this they could sign in only while someone else
    // was signed in, which is not a rule anyone could be expected to work out.
    if (!await Vault.canOpen(password)) {
      await Vault.addPassword(password);
      console.log(`[Auth] Enrolled ${user.email} on the data folder's lock.`);
    }

    req.session.isAuth = true;
    req.session.userId = user._id;
    req.session.role = user.role;
    req.session.user = {
      id: user._id,
      name: user.username,
      email: user.email,
      role: user.role
    };
    
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.json({ ok: true, redirect: destination });
    }

    res.redirect(destination);

  } catch (err) {
    console.error("Login Error:", err);
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(500).json({ ok: false, message: "Server error" });
    }
    res.redirect('/login');
  }
})



//LOGOUT
//log out, destroy cookie
/**
 * Forgot password, the only way it can work when the data is encrypted with the
 * password itself: the recovery code opens the lock, and a new password is
 * enrolled against the same key.
 *
 * There is deliberately no emailed reset link. A reset that did not carry the
 * key would sign someone into an account whose every setting was unreadable,
 * which does not look like "you need your recovery code" — it looks like the
 * app deleted their work.
 *
 * Rate limited with the same bucket as login: this is a second door onto the
 * same lock, and leaving it unlimited would make the limit on the first pointless.
 */
router.post('/recover', loginLimiter, async (req, res) => {
  const { email, recoveryCode, newPassword } = req.body;

  if (!recoveryCode || !newPassword || !email) {
    return res.status(400).json({ ok: false, message: 'Email, recovery code and a new password are all required.' });
  }
  if (String(newPassword).length < 8) {
    return res.status(400).json({ ok: false, message: 'The new password must be at least 8 characters.' });
  }

  try {
    // Normalising the code the way it is printed — in groups, upper case — so
    // that copying it back with the dashes, without them, or in lower case all
    // work. Nobody should lose their data to a transcription rule.
    const tidied = String(recoveryCode).toUpperCase().replace(/[^A-Z0-9]/g, '').match(/.{1,4}/g);
    const attempts = [String(recoveryCode).trim(), tidied ? tidied.join('-') : ''];

    let result = { ok: false };
    for (const attempt of attempts) {
      if (!attempt) continue;
      result = await Vault.recover(attempt, newPassword);
      if (result.ok) break;
    }

    if (!result.ok) {
      return res.status(401).json({ ok: false, message: 'That recovery code does not match this data folder.' });
    }

    // The lock is open, so the account record can finally be read and updated.
    const user = await UserModel.findOne({ email: normaliseEmail(email) });
    if (!user) {
      return res.status(404).json({
        ok: false,
        message: 'The recovery code was correct, but there is no account with that email address here.'
      });
    }

    user.password = await bcrypt.hash(newPassword, 12);
    await user.save();

    console.log(`[Auth] Password recovered for ${user.email} using the recovery code.`);

    return res.json({
      ok: true,
      message: 'Your password has been reset. Keep the new recovery code somewhere safe — the old one no longer works.',
      recoveryCode: result.recoveryCode,
      redirect: '/login'
    });
  } catch (err) {
    console.error('[Auth] Recovery error:', err);
    return res.status(500).json({ ok: false, message: 'Server error.' });
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.log(err);
      return res.redirect("/"); // fallback if error
    }
    res.clearCookie("connect.sid"); // clear session cookie
    res.redirect("/"); // send user back to login page
  });
});

module.exports = router;