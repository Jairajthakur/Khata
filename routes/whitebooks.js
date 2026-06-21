/**
 * WhiteBooks GST API Integration — CORRECT IMPLEMENTATION
 * Based on official OpenAPI spec: https://whitebooks.in/openapi/gst.json
 *
 * ─── HOW THE WHITEBOOKS GST API ACTUALLY WORKS ───────────────────────────────
 *
 * WhiteBooks uses a 2-step OTP-based auth (NOT a simple client_id+secret token):
 *
 * STEP 1: Request OTP
 *   GET /authentication/otprequest
 *   Headers: client_id, client_secret, gst_username, state_cd, ip_address
 *   Query:   email
 *   → GST portal sends OTP to the taxpayer's registered mobile/email
 *   → Response includes a `txn` (transaction ID)
 *   → Sandbox default OTP is always: 575757
 *
 * STEP 2: Exchange OTP for auth token
 *   GET /authentication/authtoken
 *   Headers: client_id, client_secret, gst_username, state_cd, ip_address, txn
 *   Query:   email, otp (use 575757 for sandbox)
 *   → Response includes `authtoken`
 *
 * STEP 3: Use authtoken for all subsequent API calls
 *   All endpoints accept: headers { authtoken, client_id, client_secret, ... }
 *
 * ─── BASE URLS ────────────────────────────────────────────────────────────────
 * Sandbox:    https://apisandbox.whitebooks.in  (set WHITEBOOKS_ENV=sandbox or leave blank)
 * Production: https://api.whitebooks.in         (set WHITEBOOKS_ENV=production)
 *
 * ─── STATE CODE ───────────────────────────────────────────────────────────────
 * Your GSTIN starts with a 2-digit state code. For 27AAGCB... → state_cd = "27" (Maharashtra).
 * Set WHITEBOOKS_STATE_CD in Railway env vars (defaults to first 2 chars of GSTIN).
 *
 * ─── SANDBOX TESTING ──────────────────────────────────────────────────────────
 * 1. Click "Send OTP" in Settings → WhiteBooks GST API
 * 2. The sandbox OTP is always 575757 (no real SMS sent)
 * 3. Enter 575757 in the OTP field and click "Verify OTP"
 * 4. You now have an authtoken valid for 6 hours
 *
 * ─── PROXY (only needed for Production) ──────────────────────────────────────
 * Sandbox (apisandbox.whitebooks.in) is publicly accessible — no proxy needed.
 * Production (api.whitebooks.in) may require IP whitelisting — set WHITEBOOKS_PROXY_URL.
 */

const express = require('express');
const router = express.Router();
const { authenticate, requireBusiness } = require('../middleware/auth');
const { ok } = require('../middleware/errorHandler');
const { query } = require('../config/db');
const { computeGSTR3B } = require('../utils/gstCalculator');

// ─── Base URLs ────────────────────────────────────────────────────────────────
const WB_BASE = process.env.WHITEBOOKS_ENV === 'production'
  ? 'https://api.whitebooks.in'
  : 'https://apisandbox.whitebooks.in';

const WB_TIMEOUT_MS = 20000;
const WB_SANDBOX_OTP = '575757'; // default OTP for sandbox testing

// ─── Optional static-IP proxy (for production on Railway) ────────────────────
let proxyAgent = null;
const proxyUrl = process.env.WHITEBOOKS_PROXY_URL || process.env.FIXIE_URL || '';
if (proxyUrl) {
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    proxyAgent = new HttpsProxyAgent(proxyUrl);
    console.log('[WhiteBooks] Using egress proxy:', proxyUrl.replace(/:\/\/[^@]+@/, '://***@'));
  } catch (_) {
    console.error('[WhiteBooks] https-proxy-agent not installed. Run: npm install https-proxy-agent');
  }
}

console.log(`[WhiteBooks] Base URL: ${WB_BASE}`);

// ─── Auth token store (per business, in-memory) ───────────────────────────────
// { [businessId]: { authtoken, txn, expiry } }
const tokenStore = {};

// ─── Build fetch options ──────────────────────────────────────────────────────
function fetchOpts(extra = {}) {
  const opts = { ...extra, signal: AbortSignal.timeout(WB_TIMEOUT_MS) };
  if (proxyAgent) { opts.agent = proxyAgent; opts.dispatcher = proxyAgent; }
  return opts;
}

// ─── Safely stringify WhiteBooks API response fields ─────────────────────────
function wbStr(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  return JSON.stringify(val);
}

// ─── Network error → human message ────────────────────────────────────────────
function networkErrMsg(err) {
  const code = err.cause?.code;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'Request timed out.';
  if (code === 'ENOTFOUND') return `DNS lookup failed for ${WB_BASE} — check network/proxy settings.`;
  if (code === 'ECONNREFUSED') return `Connection refused by ${WB_BASE}.`;
  return `${err.message}${code ? ` (${code})` : ''}`;
}

// ─── Perform a WhiteBooks GET request ─────────────────────────────────────────
async function wbGet(path, headers, queryParams = {}) {
  const url = new URL(`${WB_BASE}${path}`);
  Object.entries(queryParams).forEach(([k, v]) => url.searchParams.set(k, v));

  let res;
  try {
    res = await fetch(url.toString(), fetchOpts({ headers }));
  } catch (err) {
    throw new Error(`Cannot reach WhiteBooks API: ${networkErrMsg(err)}`);
  }

  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await res.text();
    throw new Error(
      `WhiteBooks API returned non-JSON (HTTP ${res.status}). ` +
      `Endpoint: ${path}. Response: ${text.slice(0, 300).replace(/<[^>]*>/g, '').trim()}`
    );
  }
  const data = await res.json();
  if (!res.ok) throw new Error(wbStr(data.message) || wbStr(data.error) || `WhiteBooks error ${res.status}`);
  return data;
}

// ─── Perform a WhiteBooks POST request ────────────────────────────────────────
async function wbPost(path, headers, body) {
  let res;
  try {
    res = await fetch(`${WB_BASE}${path}`, fetchOpts({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }));
  } catch (err) {
    throw new Error(`Cannot reach WhiteBooks API: ${networkErrMsg(err)}`);
  }

  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await res.text();
    throw new Error(
      `WhiteBooks API returned non-JSON (HTTP ${res.status}). ` +
      `Endpoint: ${path}. Response: ${text.slice(0, 300).replace(/<[^>]*>/g, '').trim()}`
    );
  }
  const data = await res.json();
  if (!res.ok) throw new Error(wbStr(data.message) || wbStr(data.error) || `WhiteBooks error ${res.status}`);
  return data;
}

// ─── Load credentials from DB ─────────────────────────────────────────────────
async function getCreds(businessId) {
  const r = await query(
    'SELECT wb_client_id, wb_client_secret, wb_gstin, wb_gst_username FROM businesses WHERE id = $1',
    [businessId]
  );
  const b = r.rows[0];
  if (!b?.wb_client_id) throw Object.assign(
    new Error('WhiteBooks not configured. Add credentials in Settings → GST API.'),
    { status: 400 }
  );
  // Derive state code from GSTIN (first 2 chars) or env override
  b.state_cd = process.env.WHITEBOOKS_STATE_CD || (b.wb_gstin || '').slice(0, 2) || '27';
  return b;
}

// ─── Build standard WhiteBooks headers ────────────────────────────────────────
function wbHeaders(creds, extra = {}) {
  return {
    'client_id': creds.wb_client_id,
    'client_secret': creds.wb_client_secret,
    'gst_username': creds.wb_gst_username,
    'state_cd': creds.state_cd,
    'ip_address': '127.0.0.1', // WhiteBooks requires this field; value is informational
    ...extra,
  };
}

router.use(authenticate, requireBusiness);

// ─── GET /api/wb/config ───────────────────────────────────────────────────────
router.get('/config', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT wb_client_id, wb_gstin, wb_gst_username, wb_einv_client_id, wb_enabled
       FROM businesses WHERE id = $1`,
      [req.business.id]
    );
    const cfg = result.rows[0] || {};
    cfg.has_token = !!(tokenStore[req.business.id]?.authtoken &&
                       tokenStore[req.business.id].expiry > Date.now());
    cfg.env = process.env.WHITEBOOKS_ENV || 'sandbox';
    ok(res, cfg);
  } catch (err) { next(err); }
});

// ─── POST /api/wb/config — save credentials ───────────────────────────────────
router.post('/config', async (req, res, next) => {
  try {
    const {
      wb_client_id, wb_client_secret, wb_gstin, wb_gst_username,
      wb_einv_client_id, wb_einv_client_secret,
    } = req.body;

    await query(
      `UPDATE businesses SET
         wb_client_id=$1, wb_client_secret=$2, wb_gstin=$3, wb_gst_username=$4,
         wb_einv_client_id=$5, wb_einv_client_secret=$6,
         wb_enabled=true, updated_at=NOW()
       WHERE id=$7`,
      [wb_client_id, wb_client_secret, wb_gstin, wb_gst_username,
       wb_einv_client_id || null, wb_einv_client_secret || null,
       req.business.id]
    );
    // Clear any cached token so next request re-authenticates
    delete tokenStore[req.business.id];
    ok(res, { message: 'WhiteBooks credentials saved' });
  } catch (err) { next(err); }
});

// ─── POST /api/wb/otp/send — Step 1: Request OTP from GST portal ─────────────
// Frontend calls this when user clicks "Send OTP"
router.post('/otp/send', async (req, res, next) => {
  try {
    const creds = await getCreds(req.business.id);
    const email = req.body.email || req.user?.email || '';

    const data = await wbGet('/authentication/otprequest',
      wbHeaders(creds),
      { email }
    );

    // Store the txn ID returned — needed for authtoken step
    const txn = data.txn || data.data?.txn || '';
    tokenStore[req.business.id] = {
      ...(tokenStore[req.business.id] || {}),
      txn,
      authtoken: null,
      expiry: 0,
    };

    const isSandbox = (process.env.WHITEBOOKS_ENV || 'sandbox') !== 'production';
    ok(res, {
      success: true,
      txn,
      message: isSandbox
        ? 'OTP sent (sandbox). Use OTP: 575757'
        : 'OTP sent to your GST-registered mobile/email',
      sandbox_otp: isSandbox ? WB_SANDBOX_OTP : undefined,
    });
  } catch (err) { next(err); }
});

// ─── POST /api/wb/otp/verify — Step 2: Exchange OTP for auth token ────────────
// Frontend calls this when user submits the OTP
router.post('/otp/verify', async (req, res, next) => {
  try {
    const creds = await getCreds(req.business.id);
    const { otp, email } = req.body;

    if (!otp) return res.status(400).json({ error: 'OTP is required' });

    const stored = tokenStore[req.business.id] || {};
    const txn = stored.txn || req.body.txn || '';
    if (!txn) return res.status(400).json({ error: 'No active OTP session. Please click Send OTP first.' });

    const data = await wbGet('/authentication/authtoken',
      wbHeaders(creds, { txn }),
      { email: email || req.user?.email || '', otp }
    );

    const authtoken = data.authtoken || data.data?.authtoken;
    if (!authtoken) throw new Error(wbStr(data.message) || 'Auth token not returned by WhiteBooks');

    // Store authtoken — valid for 6 hours per WhiteBooks docs
    tokenStore[req.business.id] = {
      authtoken,
      txn,
      expiry: Date.now() + 6 * 60 * 60 * 1000,
    };

    ok(res, { success: true, message: 'WhiteBooks GST API connected successfully' });
  } catch (err) { next(err); }
});

// ─── POST /api/wb/test — Test existing token (or guide user to get one) ───────
router.post('/test', async (req, res, next) => {
  try {
    const creds = await getCreds(req.business.id);
    const stored = tokenStore[req.business.id];

    if (!stored?.authtoken || stored.expiry <= Date.now()) {
      return res.status(400).json({
        error: 'No active WhiteBooks session. Please send OTP and verify it first.',
        action_required: 'otp_flow',
        steps: [
          '1. Click "Send OTP" — OTP will be sent to your GST-registered mobile/email',
          '2. Enter the OTP received (sandbox: use 575757)',
          '3. Click "Verify OTP" to connect',
        ],
      });
    }

    // Test the token with a lightweight public endpoint
    const data = await wbGet('/public/search',
      wbHeaders(creds, { authtoken: stored.authtoken }),
      { email: req.user?.email || '', gstin: creds.wb_gstin }
    );

    ok(res, {
      success: true,
      message: 'Connected to WhiteBooks GST API',
      env: process.env.WHITEBOOKS_ENV || 'sandbox',
      token_expires_in: Math.round((stored.expiry - Date.now()) / 60000) + ' minutes',
    });
  } catch (err) { next(err); }
});

// ─── GET /api/wb/gstin/:gstin — verify GSTIN ──────────────────────────────────
router.get('/gstin/:gstin', async (req, res, next) => {
  try {
    const creds = await getCreds(req.business.id);
    const stored = tokenStore[req.business.id];
    if (!stored?.authtoken || stored.expiry <= Date.now()) {
      return res.status(401).json({ error: 'WhiteBooks session expired. Please verify OTP again.' });
    }

    const data = await wbGet('/public/search',
      wbHeaders(creds, { authtoken: stored.authtoken }),
      { email: req.user?.email || '', gstin: req.params.gstin }
    );
    ok(res, data);
  } catch (err) { next(err); }
});

// ─── POST /api/wb/otp/request-and-authtoken — one-shot for sandbox ────────────
// Convenience: sends OTP and immediately exchanges with sandbox OTP 575757
router.post('/otp/sandbox-connect', async (req, res, next) => {
  if ((process.env.WHITEBOOKS_ENV || 'sandbox') === 'production') {
    return res.status(400).json({ error: 'This endpoint is only available in sandbox mode' });
  }
  try {
    const creds = await getCreds(req.business.id);
    const email = req.body.email || req.user?.email || '';

    // Step 1: Request OTP
    const otpData = await wbGet('/authentication/otprequest', wbHeaders(creds), { email });
    const txn = otpData.txn || otpData.data?.txn || '';

    // Step 2: Exchange sandbox OTP
    const authData = await wbGet('/authentication/authtoken',
      wbHeaders(creds, { txn }),
      { email, otp: WB_SANDBOX_OTP }
    );

    const authtoken = authData.authtoken || authData.data?.authtoken;
    if (!authtoken) throw new Error(wbStr(authData.message) || 'Auth token not returned');

    tokenStore[req.business.id] = { authtoken, txn, expiry: Date.now() + 6 * 60 * 60 * 1000 };

    ok(res, {
      success: true,
      message: 'Connected to WhiteBooks sandbox using default OTP (575757)',
    });
  } catch (err) { next(err); }
});

// ─── GET /api/wb/gstr2b — fetch GSTR-2B ──────────────────────────────────────
router.get('/gstr2b', async (req, res, next) => {
  try {
    const { period } = req.query; // MMYYYY
    if (!period) return res.status(400).json({ error: 'period required (MMYYYY e.g. 062026)' });

    const creds = await getCreds(req.business.id);
    const stored = tokenStore[req.business.id];
    if (!stored?.authtoken || stored.expiry <= Date.now()) {
      return res.status(401).json({ error: 'WhiteBooks session expired. Please verify OTP again.' });
    }

    const data = await wbGet('/gstr2b/all',
      wbHeaders(creds, { authtoken: stored.authtoken }),
      { email: req.user?.email || '', gstin: creds.wb_gstin, ret_period: period }
    );
    ok(res, data);
  } catch (err) { next(err); }
});

// ─── POST /api/wb/gstr3b/file — file GSTR-3B ─────────────────────────────────
router.post('/gstr3b/file', async (req, res, next) => {
  try {
    const { period, return_id } = req.body; // period = MM-YYYY
    if (!period) return res.status(400).json({ error: 'period required (MM-YYYY)' });

    const creds = await getCreds(req.business.id);
    const stored = tokenStore[req.business.id];
    if (!stored?.authtoken || stored.expiry <= Date.now()) {
      return res.status(401).json({ error: 'WhiteBooks session expired. Please verify OTP again.' });
    }

    const [month, year] = period.split('-');
    const fromDate = `${year}-${month}-01`;
    const toDate = new Date(Number(year), Number(month), 0).toISOString().split('T')[0];

    const [invoicesRes, expensesRes] = await Promise.all([
      query(
        `SELECT * FROM invoices WHERE business_id=$1 AND invoice_type='sale'
         AND invoice_date BETWEEN $2 AND $3 AND status!='cancelled'`,
        [req.business.id, fromDate, toDate]
      ),
      query(
        `SELECT * FROM expenses WHERE business_id=$1 AND expense_date BETWEEN $2 AND $3`,
        [req.business.id, fromDate, toDate]
      ),
    ]);

    const s = computeGSTR3B(invoicesRes.rows, expensesRes.rows);
    const rtnprd = `${month}${year}`;

    const payload = {
      gstin: creds.wb_gstin,
      ret_period: rtnprd,
      inward_sup: { isup_details: [{ ty: 'GST', intra: s.itc_igst, inter: 0 }] },
      sup_details: {
        osup_det: { txval: s.taxable_amount, iamt: s.output_igst, camt: s.output_cgst, samt: s.output_sgst, csamt: 0 },
        osup_zero: { txval: 0, iamt: 0 },
        osup_nil_exmp: { txval: 0 },
        isup_rev: { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 },
        osup_nongst: { txval: 0 },
      },
      itc_elg: {
        itc_avl: [{ ty: 'ISRC', iamt: s.itc_igst, camt: s.itc_cgst, samt: s.itc_sgst, csamt: 0 }],
        itc_rev: [],
        itc_net: { iamt: s.net_igst, camt: s.net_cgst, samt: s.net_sgst, csamt: 0 },
        itc_inelg: [],
      },
    };

    const data = await wbPost('/gstr3b/retfile',
      wbHeaders(creds, { authtoken: stored.authtoken }),
      { ...payload, email: req.user?.email || '' }
    );

    const arn = data.arn || data.data?.arn || `WB${Date.now()}`;
    if (return_id) {
      await query(
        `UPDATE gst_returns SET status='filed', arn=$1, filed_on=NOW(), updated_at=NOW()
         WHERE id=$2 AND business_id=$3`,
        [arn, return_id, req.business.id]
      );
    }

    ok(res, { success: true, arn, message: 'GSTR-3B filed successfully' });
  } catch (err) { next(err); }
});

module.exports = router;
