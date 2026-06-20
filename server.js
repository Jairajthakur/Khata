require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const { errorHandler, notFound } = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth');
const partiesRoutes = require('./routes/parties');
const invoicesRoutes = require('./routes/invoices');
const expensesRoutes = require('./routes/expenses');
const gstRoutes = require('./routes/gst');
const itrRoutes = require('./routes/itr');
const dashboardRoutes = require('./routes/dashboard');
const whatsappRoutes = require('./routes/whatsapp');
const khataRoutes = require('./routes/khata');
const whitebooksRoutes = require('./routes/whitebooks');

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'ok', time: new Date().toISOString() });
});

// ─── WhiteBooks reachability ping (unauthenticated, for debugging) ─────────
// Hit GET /api/wb-ping to confirm Railway can reach gsp.whitebooks.in.
// If reachable=false, check the error/code field:
//   ENOTFOUND  → DNS failure (domain not resolving from Railway)
//   ECONNREFUSED → TCP refused (firewall / IP block)
//   ETIMEDOUT / AbortError → timeout (IP whitelist or routing issue)
// In all cases, contact WhiteBooks support to whitelist your Railway outbound IP.
app.get('/api/wb-ping', async (req, res) => {
  const WB_BASE = 'https://gsp.whitebooks.in';
  try {
    const r = await fetch(`${WB_BASE}/api/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Intentionally wrong credentials — we just want a response, not a 200
      body: JSON.stringify({ client_id: 'ping-test', client_secret: 'ping-test' }),
      signal: AbortSignal.timeout(8000),
    });
    // Any HTTP response (even 401/400) means we *can* reach the server
    res.json({ reachable: true, http_status: r.status, note: 'WhiteBooks API is reachable from this server' });
  } catch (e) {
    res.status(502).json({
      reachable: false,
      error: e.message,
      code: e.cause?.code || (e.name === 'TimeoutError' ? 'ETIMEDOUT' : e.name),
      note: 'Railway cannot reach gsp.whitebooks.in. See routes/whitebooks.js for fix instructions.',
    });
  }
});

// Force no-cache on all API responses so Railway's proxy never returns 304
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  next();
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/parties', partiesRoutes);
app.use('/api/invoices', invoicesRoutes);
app.use('/api/expenses', expensesRoutes);
app.use('/api/gst', gstRoutes);
app.use('/api/itr', itrRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/khata', khataRoutes);
app.use('/api/wb', whitebooksRoutes);

// Serve the static demo frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404 + error handling (must be last)
app.use('/api', notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`KhataBill API running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
    console.log(`WhiteBooks reachability check: GET /api/wb-ping`);
  });
}

module.exports = app;
