const express = require('express');
const rateLimit = require('express-rate-limit');

const router = express.Router();
const SetupController = require('../controllers/SetupController.js');

// The wizard is unauthenticated by necessity — there is nobody to authenticate
// as yet. Both write steps refuse once setup is complete, so the exposure is a
// fresh install on the local network; the limiter caps what that's worth.
const setupLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    handler: (req, res) => {
        res.status(429).json({
            ok: false,
            message: 'Too many setup attempts. Please try again in 15 minutes.'
        });
    }
});

router.get('/',        SetupController.getSetup);
router.get('/status',  SetupController.getStatus);

router.post('/database', setupLimiter, SetupController.configureDatabase);
router.post('/admin',    setupLimiter, SetupController.createFirstAdmin);

module.exports = router;
