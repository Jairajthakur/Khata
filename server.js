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
const sandboxGstRoutes = require('./routes/sandboxgst');

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'ok', time: new Date().toISOString() });
});

// ─── WhiteBooks reachability ping (unauthenticated, for debugging) ─────────
// GET /api/wb-ping — confirms whether Railway can reach gsp.whitebooks.in.
// Check the response fields:
//   reachable: true  → network is fine; problem is credentials or IP whitelist
//   reachable: false → Railway blocked from reaching WhiteBooks
//     code: ENOTFOUND    → DNS failure  → set WHITEBOOKS_PROXY_URL
//     code: ECONNREFUSED → TCP refused  → set WHITEBOOKS_PROXY_URL + whitelist IP
//     code: ETIMEDOUT    → Timeout      → set WHITEBOOKS_PROXY_URL + whitelist IP
//   proxy_active: true   → WHITEBOOKS_PROXY_URL is loaded and in use
app.get('/api/wb-ping', async (req, res) => {
  const WB_BASE = process.env.WHITEBOOKS_ENV === 'production'
    ? 'https://gsp.whitebooks.in'
    : 'https://apisandbox.whitebooks.in';
  const proxyUrl = process.env.WHITEBOOKS_PROXY_URL || process.env.FIXIE_URL || '';
  let agent = null;

  if (proxyUrl) {
    try {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      agent = new HttpsProxyAgent(proxyUrl);
    } catch (_) {}
  }

  const fetchOpts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: 'ping-test', client_secret: 'ping-test' }),
    signal: AbortSignal.timeout(8000),
  };
  if (agent) {
    fetchOpts.agent = agent;
    fetchOpts.dispatcher = agent;
  }

  try {
    const r = await fetch(`${WB_BASE}/api/authenticate`, fetchOpts);
    // Any HTTP response (even 401/400) means network is reachable
    res.json({
      reachable: true,
      http_status: r.status,
      proxy_active: !!agent,
      proxy_url: proxyUrl ? proxyUrl.replace(/:\/\/.*@/, '://***@') : null,
      note: 'WhiteBooks API is reachable from this server. If Test Connection still fails, check IP whitelist on developer.whitebooks.in.',
    });
  } catch (e) {
    const code = e.cause?.code || (e.name === 'TimeoutError' ? 'ETIMEDOUT' : e.name);
    res.status(502).json({
      reachable: false,
      error: e.message,
      code,
      proxy_active: !!agent,
      proxy_url: proxyUrl ? proxyUrl.replace(/:\/\/.*@/, '://***@') : null,
      fix: proxyUrl
        ? 'Proxy is set but still failing. Verify WHITEBOOKS_PROXY_URL is correct and the proxy IP is whitelisted on developer.whitebooks.in.'
        : 'Set WHITEBOOKS_PROXY_URL in Railway env vars. Easiest: add Fixie addon on Railway → copy FIXIE_URL value to WHITEBOOKS_PROXY_URL. See routes/whitebooks.js for full instructions.',
    });
  }
});

// Force no-cache on all API responses
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
app.use('/api/sbgst', sandboxGstRoutes);

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
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
    if (!process.env.WHITEBOOKS_PROXY_URL && !process.env.FIXIE_URL) {
      console.warn('⚠  WHITEBOOKS_PROXY_URL not set — WhiteBooks API calls will fail on Railway.');
      console.warn('   Add the Fixie addon on Railway or set WHITEBOOKS_PROXY_URL manually.');
    }
  });
}

module.exports = app;
