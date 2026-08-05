// Middleware to handle authentication checks for web and API routes

// Secret for internal tools (e.g., headless PNG Exporter). Set via INTERNAL_EXPORT_SECRET in .env.
//
// Read per call, not captured at require time: setup generates the secret into
// process.env on a fresh install, after this module has already loaded.
//
// The `!secret` guard is load-bearing. Without it, an install missing the env
// var compared `undefined === undefined` for a request that sent no header at
// all, and every protected route in the app opened.
function isInternalExport(req) {
  const secret = process.env.INTERNAL_EXPORT_SECRET;
  if (!secret) return false;
  return req.headers['x-export-secret'] === secret || req.query.exportSecret === secret;
}

/**
 * Redirects to /login if the user is not authenticated.
 * Detects API requests to return 401 instead of a redirect.
 */
exports.isAuth = (req, res, next) => {
  // Bypass for headless exporter
  if (isInternalExport(req)) {
    return next();
  }

  if (req.session.isAuth) {
    return next();
  }

  // Detect API/AJAX requests
  if (req.xhr || req.originalUrl.startsWith('/api')) {
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  }

  res.redirect('/login?returnTo=' + encodeURIComponent(req.originalUrl));
};

/**
 * Returns a 401 Unauthorized JSON response if the user is not authenticated.
 */
exports.isAuthApi = (req, res, next) => {
  // Bypass for headless exporter
  if (isInternalExport(req)) {
    return next();
  }

  if (req.session.isAuth) {
    next();
  } else {
    res.status(401).json({ ok: false, message: "Unauthorized" });
  }
};

function checkAccess(req, res, next, allowedRoles, fallbackRoute, errorMessage) {
    if (isInternalExport(req)) {
        return next();
    }

    if (!req.session.isAuth) {
        if (req.xhr || req.originalUrl.startsWith('/api')) {
            return res.status(401).json({ ok: false, message: "Unauthorized" });
        }
        return res.redirect('/login?returnTo=' + encodeURIComponent(req.originalUrl));
    }

    if (allowedRoles.includes(req.session.role)) {
        return next();
    }

    if (req.xhr || req.originalUrl.startsWith('/api')) {
        return res.status(403).json({ ok: false, message: errorMessage });
    }
    res.redirect(fallbackRoute);
}

/**
 * Checks if the user has moderator or admin privileges.
 */
exports.isModerator = async (req, res, next) => {
    checkAccess(req, res, next, ['moderator', 'admin'], '/library', "Forbidden: Moderator access required");
};

/**
 * Checks if the user has administrator privileges.
 */
exports.isAdmin = async (req, res, next) => {
    checkAccess(req, res, next, ['admin'], '/dashboard', "Forbidden: Admin access required");
};
