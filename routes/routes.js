const express = require('express');
const router = express.Router();

const SiteController = require('../controllers/SiteController.js');
const DashboardController = require('../controllers/DashboardController.js');

const { isAuth } = require('../middleware/auth.js');

// --- HTML PAGE ROUTES ---
//
// The Prose Engine has exactly two pages: the login form and the dashboard.
// There is no public landing page and no reader — the comic server's library
// browser and viewer existed to display panel art, and a manuscript has none.
// "/" goes straight to the work.

router.get('/', (req, res) => res.redirect('/dashboard'));

router.get('/login', SiteController.getLogin);

router.get('/dashboard', isAuth, DashboardController.getDashboard);

module.exports = router;
