const express = require("express");
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const router = express.Router();

//USER SCHEMA
const UserModel = require('../models/User.js');
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