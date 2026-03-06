// middleware/errorHandler.js
// Global error handler. Must be registered LAST in server.js.
// Hides stack traces in production. Returns consistent JSON error shape.
//
// Usage in server.js (must be after all routes):
//   app.use(errorHandler);

/**
 * Express error-handling middleware (4 arguments required).
 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars

  // ── Determine status code ─────────────────────────────────────────────────
  let statusCode = err.statusCode || err.status || 500;

  // mongoose validation errors → 400
  if (err.name === 'ValidationError') statusCode = 400;

  // mongoose duplicate key → 409
  if (err.code === 11000) statusCode = 409;

  // JWT errors → 401
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') statusCode = 401;

  // ethers.js / blockchain errors → 502
  if (err.message && (
    err.message.includes('CALL_EXCEPTION') ||
    err.message.includes('network') ||
    err.message.includes('provider')
  )) statusCode = 502;

  // ── Build error message ───────────────────────────────────────────────────
  let message = err.message || 'An unexpected error occurred.';

  // Sanitize mongoose duplicate key message
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    message = `Duplicate value for ${field}.`;
  }

  // ── Log the error ─────────────────────────────────────────────────────────
  const isProduction = process.env.NODE_ENV === 'production';

  if (statusCode >= 500) {
    console.error(`[Error] ${statusCode} ${req.method} ${req.path}`);
    console.error('[Error] Message:', message);
    if (!isProduction) console.error('[Error] Stack:', err.stack);
  } else {
    console.warn(`[Warn] ${statusCode} ${req.method} ${req.path} — ${message}`);
  }

  // ── Send response ─────────────────────────────────────────────────────────
  const response = {
    success: false,
    message,
  };

  // Include stack trace only in development
  if (!isProduction && err.stack) {
    response.stack = err.stack;
  }

  // Include validation details for 400 errors
  if (err.name === 'ValidationError' && err.errors) {
    response.errors = Object.keys(err.errors).reduce((acc, key) => {
      acc[key] = err.errors[key].message;
      return acc;
    }, {});
  }

  res.status(statusCode).json(response);
}

/**
 * 404 handler — register BEFORE errorHandler but AFTER all routes.
 * Usage in server.js:
 *   app.use(notFoundHandler);
 *   app.use(errorHandler);
 */
function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.path}`,
  });
}

module.exports = { errorHandler, notFoundHandler };