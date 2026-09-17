const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const AccountsController = require('../controllers/AccountsController.js');
const { isAdmin } = require('../middleware/auth.js');

// No keyGenerator: the default one is used deliberately.
//
// It used to be `req.ip`, which express-rate-limit complains about on every
// boot, and it is right to. An IPv6 user is normally handed a whole /64 — so
// keying on the full address lets one person walk through addresses and make
// five account requests each, which is not a limit. The default groups IPv6
// addresses by prefix and handles IPv4 as before.
const requestLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5,
    handler: (req, res) => {
        res.status(429).json({
            ok: false,
            message: 'Too many account requests from this IP. Please try again later.'
        });
    }
});

// Public
router.post('/request', requestLimiter, AccountsController.requestAccount);

// Admin only
router.get('/requests',         isAdmin, AccountsController.getRequests);
router.get('/users',            isAdmin, AccountsController.getUsers);
router.post('/create',          isAdmin, AccountsController.createAccount);
router.post('/approve/:requestId', isAdmin, AccountsController.approveRequest);
router.post('/deny/:requestId',    isAdmin, AccountsController.denyRequest);
router.delete('/delete/:userId',   isAdmin, AccountsController.deleteAccount);

// Password resets are an admin job now, and they have to be: the data folder is
// encrypted with the writer's password, so a reset is only possible for someone
// who already holds the key — which means someone who is already signed in.
router.post('/password/:userId',   isAdmin, AccountsController.resetPassword);

module.exports = router;
