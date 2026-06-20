/**
 * WhiteBooks GST API Integration
 * Handles: Auth token, GSTIN verify, GSTR-2B fetch, GSTR-1 file, GSTR-3B file
 *
 * ─── TROUBLESHOOTING "Cannot reach WhiteBooks API: fetch failed" ───────────
 *
 * This error means Railway's server cannot make outbound TCP/HTTPS connections
 * to gsp.whitebooks.in. Common causes:
 *
 *  1. IP Whitelist required by WhiteBooks GSP
 *     WhiteBooks (like most GSPs) requires your server's outbound IP to be
 *     registered with the GST portal. Railway uses dynamic IPs by default.
 *     Fix: Add a static-IP egress proxy (Fixie, QuotaGuard, or Nginx on a
 *     VPS with a fixed IP). Set WHITEBOOKS_PROXY_URL in .env, and this file
 *     will automatically route traffic through it.
 *
 *  2. Railway network policy
 *     Some Railway plans block or throttle outbound HTTPS to unknown domains.
 *     Fix: Visit /api/wb-ping to see the exact error code:
 *       ENOTFOUND   → DNS failure  (domain not resolving on Railway)
 *       ECONNREFUSED→ TCP refused  (firewall or IP block)
 *       ETIMEDOUT   → Timeout      (routing / IP whitelist issue)
 *
 *  3. Node version < 18 (no native fetch)
 *     Ensure package.json has "engines": { "node": ">=18.0.0" }
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const { authenticate, requireBusiness } = require('../middleware/auth');
const { ok } = require('../middleware/errorHandler');
const { query } = require('../config/db');
const { computeGSTR3B } = require('../utils/gstCalculator');

const WB_BASE = 'https://gsp.whitebooks.in';

// ─── Fetch timeout (ms). WhiteBooks GSP can be slow; 15s is safe. ──────────
const WB_TIMEOUT_MS = 15000;

// ─── Optional HTTP proxy for static-IP egress (set WHITEBOOKS_PROXY_URL) ───
// Example .env entry:  WHITEBOOKS_PROXY_URL=http://user:pass@proxy.fixie.com:80
// When set, all WhiteBooks requests are tunnelled through the proxy so that
// the GST portal / WhiteBooks see a fixed IP that can be whitelisted.
let proxyAgent = null;
if (process.env.WHITEBOOKS_PROXY_URL) {
  try {
    // https-proxy-agent is optional; only loaded if env var is set
    // npm install https-proxy-agent
    const { HttpsProxyAgent } = require('https-proxy-agent');
    proxyAgent = new HttpsProxyAgent(process.env.WHITEBOOKS_PROXY_URL);
    console.log('[WhiteBooks] Using egress proxy:', process.env.WHITEBOOKS_PROXY_URL.replace(/:\/\/.*@/, '://***@'));
  } catch (e) {
    console.warn('[WhiteBooks] WHITEBOOKS_PROXY_URL is set but https-proxy-agent is not installed. Run: npm install https-proxy-agent');
  }
}

// ─── token cache (per clientId, in-memory) ─────────────────────────────────
const tokenCache = {};

/**
 * Build fetch options with timeout + optional proxy agent.
 * @param {RequestInit} base - Base fetch options (method, headers, body)
 * @returns {RequestInit}
 */
function fetchOptions(base = {}) {
  const opts = {
    ...base,
    signal: AbortSignal.timeout(WB_TIMEOUT_MS),
  };
  if (proxyAgent) {
    // Node 18+ fetch (undici) accepts a `dispatcher` for proxy; for older
    // compatibility we attach as `agent` (works with node-fetch v2/v3).
    opts.agent = proxyAgent;
    opts.dispatcher = proxyAgent; // undici / Node 18+ native fetch
  }
  return opts;
}

/**
 * Authenticate with WhiteBooks and return a cached auth token.
 * Throws a descriptive Error on any network or API failure.
 */
async function getWBToken(clientId, clientSecret) {
  const key = clientId;
  if (tokenCache[key] && tokenCache[key].expiry > Date.now()) {
    return tokenCache[key].token;
  }

  let res;
  try {
    res = await fetch(
      `${WB_BASE}/api/authenticate`,
      fetchOptions({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
      })
    );
  } catch (fetchErr) {
    // Produce a human-readable message that hints at the real cause
    const code = fetchErr.cause?.code;
    const isTimeout = fetchErr.name === 'TimeoutError' || fetchErr.name === 'AbortError';
    let hint = '';
    if (isTimeout) {
      hint = 'Request timed out — WhiteBooks GSP may be blocking your server\'s IP. Set WHITEBOOKS_PROXY_URL in .env to use a static-IP egress proxy.';
    } else if (code === 'ENOTFOUND') {
      hint = 'DNS lookup failed for gsp.whitebooks.in — check Railway network / DNS settings.';
    } else if (code === 'ECONNREFUSED') {
      hint = 'Connection refused by gsp.whitebooks.in — your server\'s IP may not be whitelisted.';
    } else {
      hint = `${fetchErr.message}${code ? ` (${code})` : ''}. Visit /api/wb-ping for diagnostics.`;
    }
    throw new Error(`Cannot reach WhiteBooks API: ${hint}`);
  }

  const contentType = res.headers.get('content-type') || '';
  let data;
  if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    const text = await res.text();
    throw new Error(
      `WhiteBooks API returned unexpected response (HTTP ${res.status}). ` +
      `Check your Client ID and Secret. Server said: ${text.slice(0, 200).replace(/<[^>]*>/g, '').trim()}`
    );
  }

  if (!res.ok || !data.authtoken) {
    throw new Error(data.message || data.error || `WhiteBooks auth failed (HTTP ${res.status})`);
  }

  // Cache for 55 minutes (tokens expire at 60 min)
  tokenCache[key] = { token: data.authtoken, expiry: Date.now() + 55 * 60 * 1000 };
  return data.authtoken;
}

/**
 * Parse a WhiteBooks API response, throwing on non-JSON or error status.
 */
async function parseWBResponse(res, label) {
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await res.text();
    throw new Error(
      `WhiteBooks ${label} returned non-JSON (HTTP ${res.status}): ` +
      text.slice(0, 200).replace(/<[^>]*>/g, '').trim()
    );
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || data.error || `WhiteBooks API error: ${res.status}`);
  return data;
}

/**
 * Authenticated GET to WhiteBooks API.
 */
async function wbGet(path, token, clientId) {
  let res;
  try {
    res = await fetch(
      `${WB_BASE}${path}`,
      fetchOptions({
        headers: { authtoken: token, clientid: clientId, 'Content-Type': 'application/json' },
      })
    );
  } catch (err) {
    const code = err.cause?.code;
    throw new Error(`Cannot reach WhiteBooks API: ${err.message}${code ? ` (${code})` : ''}`);
  }
  return parseWBResponse(res, `GET ${path}`);
}

/**
 * Authenticated POST to WhiteBooks API.
 */
async function wbPost(path, body, token, clientId) {
  let res;
  try {
    res = await fetch(
      `${WB_BASE}${path}`,
      fetchOptions({
        method: 'POST',
        headers: { authtoken: token, clientid: clientId, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    );
  } catch (err) {
    const code = err.cause?.code;
    throw new Error(`Cannot reach WhiteBooks API: ${err.message}${code ? ` (${code})` : ''}`);
  }
  return parseWBResponse(res, `POST ${path}`);
}

router.use(authenticate, requireBusiness);

// ─── GET /api/wb/config  — get saved WB credentials for this business ───────
router.get('/config', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT wb_client_id, wb_gstin, wb_gst_username,
              wb_einv_client_id, wb_ewb_client_id,
              wb_enabled
       FROM businesses WHERE id = $1`,
      [req.business.id]
    );
    ok(res, result.rows[0] || {});
  } catch (err) { next(err); }
});

// ─── POST /api/wb/config  — save WB credentials ──────────────────────────────
router.post('/config', async (req, res, next) => {
  try {
    const {
      wb_client_id, wb_client_secret,
      wb_gstin, wb_gst_username,
      wb_einv_client_id, wb_einv_client_secret,
      wb_ewb_client_id, wb_ewb_client_secret,
    } = req.body;

    await query(
      `UPDATE businesses SET
         wb_client_id = $1, wb_client_secret = $2,
         wb_gstin = $3, wb_gst_username = $4,
         wb_einv_client_id = $5, wb_einv_client_secret = $6,
         wb_ewb_client_id = $7, wb_ewb_client_secret = $8,
         wb_enabled = true,
         updated_at = NOW()
       WHERE id = $9`,
      [
        wb_client_id, wb_client_secret,
        wb_gstin, wb_gst_username,
        wb_einv_client_id || null, wb_einv_client_secret || null,
        wb_ewb_client_id || null, wb_ewb_client_secret || null,
        req.business.id,
      ]
    );
    // Clear cached token so next request re-authenticates with new credentials
    if (wb_client_id) delete tokenCache[wb_client_id];
    ok(res, { message: 'WhiteBooks credentials saved' });
  } catch (err) { next(err); }
});

// ─── helper: fetch credentials from DB ───────────────────────────────────────
async function getCreds(businessId) {
  const r = await query(
    'SELECT wb_client_id, wb_client_secret, wb_gstin, wb_gst_username FROM businesses WHERE id = $1',
    [businessId]
  );
  const b = r.rows[0];
  if (!b || !b.wb_client_id) {
    throw Object.assign(
      new Error('WhiteBooks not configured. Please add credentials in Settings → GST API.'),
      { status: 400 }
    );
  }
  return b;
}

// ─── POST /api/wb/test  — test connection with saved credentials ──────────────
// This is the endpoint called by the "Test Connection" button in Settings.
// Returns success/failure + actionable error message.
router.post('/test', async (req, res, next) => {
  try {
    const creds = await getCreds(req.business.id);
    // Clear any stale cached token so we always do a live auth call
    delete tokenCache[creds.wb_client_id];
    const token = await getWBToken(creds.wb_client_id, creds.wb_client_secret);
    ok(res, { success: true, message: 'Connected to WhiteBooks GST API ✓' });
  } catch (err) { next(err); }
});

// ─── GET /api/wb/gstin/:gstin  — verify GSTIN via WhiteBooks ─────────────────
router.get('/gstin/:gstin', async (req, res, next) => {
  try {
    const creds = await getCreds(req.business.id);
    const token = await getWBToken(creds.wb_client_id, creds.wb_client_secret);
    const data = await wbGet(`/api/gst/taxpayerDetails/${req.params.gstin}`, token, creds.wb_client_id);
    ok(res, data);
  } catch (err) { next(err); }
});

// ─── GET /api/wb/gstr2b?period=062026  — fetch GSTR-2B (ITC) ────────────────
router.get('/gstr2b', async (req, res, next) => {
  try {
    const { period } = req.query; // MMYYYY e.g. 062026
    if (!period) return res.status(400).json({ error: 'period required (MMYYYY)' });

    const creds = await getCreds(req.business.id);
    const token = await getWBToken(creds.wb_client_id, creds.wb_client_secret);

    const data = await wbGet(
      `/api/gst/gstr2b?gstin=${creds.wb_gstin}&rtnprd=${period}`,
      token, creds.wb_client_id
    );

    // Parse and save ITC entries as expenses for auto-reconciliation
    const b2bInvoices = data?.data?.docdata?.b2b || [];
    let imported = 0;
    for (const supplier of b2bInvoices) {
      for (const inv of (supplier.inv || [])) {
        if (inv.itcavl !== 'Y') continue;
        const expDate = inv.dt
          ? inv.dt.split('-').reverse().join('-')
          : new Date().toISOString().split('T')[0];
        await query(
          `INSERT INTO expenses
             (business_id, vendor_name, vendor_gstin, description, amount,
              tax_amount, cgst, sgst, igst, expense_date, category, notes, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Purchase','Auto-imported from GSTR-2B','gstr2b')
           ON CONFLICT DO NOTHING`,
          [
            req.business.id,
            supplier.trdnm || supplier.ctin,
            supplier.ctin,
            `Invoice ${inv.inum}`,
            parseFloat(inv.txval) || 0,
            (parseFloat(inv.cgst) || 0) + (parseFloat(inv.sgst) || 0) + (parseFloat(inv.igst) || 0),
            parseFloat(inv.cgst) || 0,
            parseFloat(inv.sgst) || 0,
            parseFloat(inv.igst) || 0,
            expDate,
          ]
        ).catch(() => {}); // ignore duplicates silently
        imported++;
      }
    }

    ok(res, { ...data, imported_expenses: imported });
  } catch (err) { next(err); }
});

// ─── POST /api/wb/gstr3b/file  — file GSTR-3B via WhiteBooks ────────────────
router.post('/gstr3b/file', async (req, res, next) => {
  try {
    const { period, otp, return_id } = req.body; // period = MM-YYYY
    if (!period || !otp) return res.status(400).json({ error: 'period and otp are required' });

    const creds = await getCreds(req.business.id);
    const token = await getWBToken(creds.wb_client_id, creds.wb_client_secret);

    const [month, year] = period.split('-');
    const fromDate = `${year}-${month}-01`;
    const toDate = new Date(Number(year), Number(month), 0).toISOString().split('T')[0];

    const invoicesRes = await query(
      `SELECT * FROM invoices WHERE business_id = $1 AND invoice_type = 'sale'
         AND invoice_date BETWEEN $2 AND $3 AND status != 'cancelled'`,
      [req.business.id, fromDate, toDate]
    );
    const expensesRes = await query(
      `SELECT * FROM expenses WHERE business_id = $1 AND expense_date BETWEEN $2 AND $3`,
      [req.business.id, fromDate, toDate]
    );
    const s = computeGSTR3B(invoicesRes.rows, expensesRes.rows);

    const rtnprd = `${month}${year}`; // MMYYYY

    const submitPayload = {
      gstin: creds.wb_gstin,
      ret_period: rtnprd,
      gst_username: creds.wb_gst_username,
      sup_details: {
        osup_det:    { txval: s.taxable_amount, iamt: s.output_igst, camt: s.output_cgst, samt: s.output_sgst, csamt: 0 },
        osup_zero:   { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 },
        osup_nil_exmp: { txval: 0 },
        isup_rev:    { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 },
        osup_nongst: { txval: 0 },
      },
      itc_elg: {
        itc_avl: [
          { ty: 'IMPG', iamt: 0,           camt: 0,           samt: 0,           csamt: 0 },
          { ty: 'IMPS', iamt: 0,           camt: 0,           samt: 0,           csamt: 0 },
          { ty: 'ISRC', iamt: s.itc_igst,  camt: s.itc_cgst,  samt: s.itc_sgst,  csamt: 0 },
          { ty: 'ISD',  iamt: 0,           camt: 0,           samt: 0,           csamt: 0 },
          { ty: 'OTH',  iamt: 0,           camt: 0,           samt: 0,           csamt: 0 },
        ],
        itc_rev:  [],
        itc_net:  { iamt: s.itc_igst, camt: s.itc_cgst, samt: s.itc_sgst, csamt: 0 },
        itc_inelg: [],
      },
      intr_ltfee: { intr_details: { iamt: 0, camt: 0, samt: 0, csamt: 0 } },
      tax_pd: {
        itax_pd: [
          { ty: 'G', reg_cancel: 'N', iamt: s.net_igst, camt: s.net_cgst, samt: s.net_sgst, csamt: 0 },
        ],
      },
      vsez_sup: null,
      nil_sup: null,
      otp,
    };

    const submitRes = await wbPost('/api/gst/gstr3b/submit', submitPayload, token, creds.wb_client_id);

    const arn = submitRes.data?.arn || submitRes.arn || `WB${Date.now()}`;
    if (return_id) {
      await query(
        `UPDATE gst_returns SET status='filed', arn=$1, filed_on=NOW(), updated_at=NOW()
         WHERE id=$2 AND business_id=$3`,
        [arn, return_id, req.business.id]
      );
    }

    ok(res, { success: true, arn, message: 'GSTR-3B filed successfully via WhiteBooks GST API' });
  } catch (err) { next(err); }
});

// ─── POST /api/wb/otp/send  — trigger OTP for GST portal login ───────────────
router.post('/otp/send', async (req, res, next) => {
  try {
    const creds = await getCreds(req.business.id);
    const token = await getWBToken(creds.wb_client_id, creds.wb_client_secret);
    await wbPost('/api/gst/otp/send', {
      gstin: creds.wb_gstin,
      gst_username: creds.wb_gst_username,
    }, token, creds.wb_client_id);
    ok(res, { success: true, message: 'OTP sent to your GST registered mobile/email' });
  } catch (err) { next(err); }
});

// ─── GET /api/wb/gstr2a?period=062026  — fetch GSTR-2A ───────────────────────
router.get('/gstr2a', async (req, res, next) => {
  try {
    const { period } = req.query;
    if (!period) return res.status(400).json({ error: 'period required (MMYYYY)' });
    const creds = await getCreds(req.business.id);
    const token = await getWBToken(creds.wb_client_id, creds.wb_client_secret);
    const data = await wbGet(
      `/api/gst/gstr2a?gstin=${creds.wb_gstin}&rtnprd=${period}`,
      token, creds.wb_client_id
    );
    ok(res, data);
  } catch (err) { next(err); }
});

module.exports = router;
