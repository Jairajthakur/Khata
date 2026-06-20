/**
 * WhiteBooks GST API Integration
 * Handles: Auth token, GSTIN verify, GSTR-2B fetch, GSTR-1 file, GSTR-3B file
 *
 * ─── FIX: DNS / Network failure on Railway ───────────────────────────────────
 *
 * The error "Cannot reach WhiteBooks API: DNS lookup failed for gsp.whitebooks.in"
 * means Railway's server cannot resolve or reach gsp.whitebooks.in.
 *
 * ROOT CAUSE: Railway uses dynamic/shared IPs. WhiteBooks GSP (like all GSPs)
 * requires your server's outbound IP to be whitelisted with the GST portal.
 * Dynamic IPs are never whitelisted, so connections are blocked at the DNS/TCP level.
 *
 * SOLUTION: Use a static-IP egress proxy so WhiteBooks always sees a fixed IP.
 *
 * STEP 1 — Install proxy agent (already in package.json):
 *   npm install https-proxy-agent
 *
 * STEP 2 — Get a static-IP proxy (free tiers available):
 *   Option A: Fixie (https://usefixie.com) — easiest, Railway addon available
 *     Railway Dashboard → your project → + New → Fixie
 *     This auto-sets FIXIE_URL env var. Copy that value to WHITEBOOKS_PROXY_URL.
 *   Option B: QuotaGuard Static (https://quotaguard.com)
 *   Option C: Your own Nginx/Squid on a ₹200/mo VPS with static IP
 *
 * STEP 3 — Set Railway environment variable:
 *   WHITEBOOKS_PROXY_URL=http://user:pass@criterium.usefixie.com:80
 *   (or whatever your proxy provider gives you)
 *
 * STEP 4 — Whitelist the proxy's static IP with WhiteBooks:
 *   Login to developer.whitebooks.in → Credentials → your GSTIN → IP Whitelist
 *   Add the static IP from your proxy provider.
 *
 * STEP 5 — Redeploy on Railway. Test via GET /api/wb-ping first.
 *
 * ─── DIAGNOSING THE EXACT ERROR ──────────────────────────────────────────────
 * Visit GET /api/wb-ping (no auth required) to see the exact error code:
 *   ENOTFOUND    → DNS failure  → Railway can't resolve gsp.whitebooks.in
 *   ECONNREFUSED → TCP refused  → your IP is blocked / not whitelisted
 *   ETIMEDOUT    → Timeout      → routing / IP whitelist issue
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const { authenticate, requireBusiness } = require('../middleware/auth');
const { ok } = require('../middleware/errorHandler');
const { query } = require('../config/db');
const { computeGSTR3B } = require('../utils/gstCalculator');

// Use sandbox URL for testing; switch to https://gsp.whitebooks.in for production
const WB_BASE = process.env.NODE_ENV === 'production' && process.env.WHITEBOOKS_ENV === 'production'
  ? 'https://gsp.whitebooks.in'
  : 'https://apisandbox.whitebooks.in';

// ─── Fetch timeout (ms). WhiteBooks GSP can be slow; 20s is safe. ───────────
const WB_TIMEOUT_MS = 20000;

// ─── Static-IP egress proxy for Railway ─────────────────────────────────────
// Set WHITEBOOKS_PROXY_URL in Railway environment variables.
// Example: WHITEBOOKS_PROXY_URL=http://user:pass@criterium.usefixie.com:80
//
// If you added Fixie as a Railway addon, it sets FIXIE_URL automatically.
// In that case set: WHITEBOOKS_PROXY_URL=${FIXIE_URL}
let proxyAgent = null;
const proxyUrl = process.env.WHITEBOOKS_PROXY_URL || process.env.FIXIE_URL || '';

if (proxyUrl) {
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    proxyAgent = new HttpsProxyAgent(proxyUrl);
    console.log('[WhiteBooks] ✓ Using egress proxy:', proxyUrl.replace(/:\\/\\/.*@/, '://***@'));
  } catch (e) {
    console.error('[WhiteBooks] ✗ https-proxy-agent not installed. Run: npm install https-proxy-agent');
    console.error('[WhiteBooks]   Without a proxy, Railway cannot reach gsp.whitebooks.in.');
  }
} else {
  console.warn('[WhiteBooks] ⚠ No WHITEBOOKS_PROXY_URL set.');
  console.warn('[WhiteBooks]   On Railway, requests to gsp.whitebooks.in will likely fail (ENOTFOUND/ECONNREFUSED).');
  console.warn('[WhiteBooks]   Add Fixie addon on Railway or set WHITEBOOKS_PROXY_URL. See routes/whitebooks.js header.');
}

// ─── Token cache (per clientId, in-memory) ───────────────────────────────────
const tokenCache = {};

/**
 * Build fetch options with timeout + proxy agent.
 * Works with both Node 18+ native fetch (undici) and node-fetch.
 */
function fetchOptions(base = {}) {
  const opts = {
    ...base,
    signal: AbortSignal.timeout(WB_TIMEOUT_MS),
  };
  if (proxyAgent) {
    opts.agent = proxyAgent;       // node-fetch / older compat
    opts.dispatcher = proxyAgent;  // undici / Node 18+ native fetch
  }
  return opts;
}

/**
 * Convert a raw fetch error into a human-readable message with a fix hint.
 */
function humanizeNetworkError(err) {
  const code = err.cause?.code;
  const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';

  if (isTimeout) {
    return proxyAgent
      ? 'Request timed out via proxy — ensure the proxy\'s static IP is whitelisted with WhiteBooks.'
      : 'Request timed out — Railway cannot reach gsp.whitebooks.in. Add WHITEBOOKS_PROXY_URL (see Fixie addon).';
  }
  if (code === 'ENOTFOUND') {
    return proxyAgent
      ? 'DNS lookup failed even via proxy — check WHITEBOOKS_PROXY_URL is correct.'
      : 'DNS lookup failed for gsp.whitebooks.in — Railway cannot resolve this domain. Set WHITEBOOKS_PROXY_URL in Railway env vars (see routes/whitebooks.js).';
  }
  if (code === 'ECONNREFUSED') {
    return proxyAgent
      ? 'Connection refused via proxy — ensure the proxy\'s static IP is whitelisted with WhiteBooks GSP.'
      : 'Connection refused by gsp.whitebooks.in — your server\'s IP is not whitelisted. Set WHITEBOOKS_PROXY_URL.';
  }
  if (code === 'ECONNRESET') {
    return 'Connection was reset — WhiteBooks GSP may be temporarily down. Retry in a few minutes.';
  }
  return `${err.message}${code ? ` (${code})` : ''}. Visit /api/wb-ping for diagnostics.`;
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
    throw new Error(`Cannot reach WhiteBooks API: ${humanizeNetworkError(fetchErr)}`);
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
    throw new Error(`Cannot reach WhiteBooks API: ${humanizeNetworkError(err)}`);
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
    throw new Error(`Cannot reach WhiteBooks API: ${humanizeNetworkError(err)}`);
  }
  return parseWBResponse(res, `POST ${path}`);
}

router.use(authenticate, requireBusiness);

// ─── GET /api/wb/config  — get saved WB credentials for this business ────────
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

// ─── Helper: fetch credentials from DB ───────────────────────────────────────
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
router.post('/test', async (req, res, next) => {
  try {
    const creds = await getCreds(req.business.id);
    // Clear stale cached token so we always do a live auth call
    delete tokenCache[creds.wb_client_id];
    await getWBToken(creds.wb_client_id, creds.wb_client_secret);
    ok(res, {
      success: true,
      message: 'Connected to WhiteBooks GST API ✓',
      proxy_active: !!proxyAgent,
    });
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
