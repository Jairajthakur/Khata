const errorHandler = (err, req, res, next) => {
  const errStr = err instanceof Error
    ? err.message
    : (typeof err === 'object' ? JSON.stringify(err) : String(err));
  console.error(`[${new Date().toISOString()}] ERROR:`, errStr);

  if (err.code === '23505') { // PostgreSQL unique violation
    return res.status(409).json({ error: 'Record already exists', detail: err.detail });
  }
  if (err.code === '23503') { // foreign key violation
    return res.status(400).json({ error: 'Referenced record not found' });
  }
  if (err.code === '23502') { // not null violation
    return res.status(400).json({ error: 'Required field missing', detail: err.column });
  }

  const status = err.status || 500;
  // Always serialize error as a plain string so the frontend never receives [object Object]
  const message = typeof err.message === 'string'
    ? err.message
    : (err.message ? JSON.stringify(err.message) : 'Internal server error');
  res.status(status).json({
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

const notFound = (req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
};

const ok = (res, data, meta = {}) => res.json({ success: true, data, ...meta });
const created = (res, data) => res.status(201).json({ success: true, data });

module.exports = { errorHandler, notFound, ok, created };
