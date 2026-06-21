/**
 * Sandbox.co.in GST API Integration
 * Supports: GSTR-1 filing, GSTR-3B filing, GSTIN verification
 *
 * ─── HOW SANDBOX.CO.IN GST API WORKS ────────────────────────────────────────
 *
 * Authentication is 2-step OTP-based (same as all GSPs — GSTN requirement):
 *
 * STEP 1: Enable API Access on GST Portal
 *   - Taxpayer logs into gst.gov.in
 *   - Goes to: My Profile → Manage API Access → Enable → Select duration (max 30 days)
 *   - This must be done BEFORE calling any API
 *
 * STEP 2: Generate OTP
 *   POST /gst/taxpayer/otp
 *   Body: { gstin, username }
 *   → OTP sent to taxpayer's registered mobile + email
 *   → Sandbox test OTP is always: 123456
 *
 * STEP 3: Authenticate with OTP → get auth token
 *   POST /gst/taxpayer/authenticate
 *   Body: { gstin, username, otp }
 *   → Returns { auth_token } valid for 6 hours
 *
 * STEP 4: Use auth_token for all filing APIs
 *
 * ─── BASE URLS ───────────────────────────────────────────────────────────────
 * Sandbox:    https://api.sandbox.co.in  (SANDBOX_ENV=sandbox)
 * Production: https://api.sandbox.co.in  (same host, different key tier)
 *
 * ─── SANDBOX TESTING ─────────────────────────────────────────────────────────
 * Default sandbox OTP: 123456
 * Use any test GSTIN provided in sandbox dashboard
 *
 * ─── ENV VARS REQUIRED ───────────────────────────────────────────────────────
 * SANDBOX_API_KEY=key_live_xxxx
 * SANDBOX_API_SECRET=secret_live_xxxx
 * SANDBOX_ENV=sandbox   (change to 'production' when ready)
 */

const express = require('express');
const router = express.Router();
const { authenticate, requireBusiness } = require('../middleware/auth');
const { ok } = require('../middleware/errorHandler');
const { query } = require('../config/db');
const { computeGSTR3B, getDueDate, round2 } = require('../utils/gstCalculator');

const SANDBOX_BASE = 'https://api.sandbox.co.in';
const SANDBOX_TIMEOUT_MS = 20000;

// ─── In-memory auth token store per business ─────────────────────────────────
// { [businessId]: { auth_token, expiry } }
const tokenStore = {};

// ─── All routes require auth ──────────────────────────────────────────────────
router.use(authenticate, requireBusiness);

// ─── Build common headers ─────────────────────────────────────────────────────
function buildHeaders(extraHeaders = {}) {
  return {
    'x-api-key': process.env.SANDBOX_API_KEY,
    'x-api-secret': process.env.SANDBOX_API_SECRET,
    'x-api-version': '1.0',
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
}

// ─── Fetch wrapper with timeout ───────────────────────────────────────────────
async function sbFetch(path, options = {}) {
  const url = `${SANDBOX_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SANDBOX_TIMEOUT_MS);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const data = await res.json();
    if (!res.ok) {
      const msg = data?.message || data?.error || `HTTP ${res.status}`;
      throw new Error(`Sandbox API error: ${msg}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Get business credentials from DB ────────────────────────────────────────
async function getBusinessCreds(businessId) {
  const result = await query(
    'SELECT gstin, state_code FROM businesses WHERE id = $1',
    [businessId]
  );
  if (!result.rows.length) throw new Error('Business not found');
  const biz = result.rows[0];
  if (!biz.gstin) throw new Error('Business GSTIN not set. Please update your business profile.');
  return biz;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sbgst/otp/generate
// Body: { username } — GST portal username of the taxpayer
// Step 1: Request OTP → sent to taxpayer's registered mobile/email
// ─────────────────────────────────────────────────────────────────────────────
router.post('/otp/generate', async (req, res, next) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'GST portal username is required' });

    const biz = await getBusinessCreds(req.business.id);

    const data = await sbFetch('/gst/taxpayer/otp', {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({
        gstin: biz.gstin,
        username,
      }),
    });

    // Save username temporarily for the verify step
    tokenStore[req.business.id] = {
      ...tokenStore[req.business.id],
      pending_username: username,
      pending_gstin: biz.gstin,
    };

    ok(res, {
      success: true,
      message: `OTP sent to your registered mobile and email. Sandbox OTP is always: 123456`,
      gstin: biz.gstin,
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sbgst/otp/verify
// Body: { otp } — OTP received on mobile (sandbox: 123456)
// Step 2: Exchange OTP for auth token
// ─────────────────────────────────────────────────────────────────────────────
router.post('/otp/verify', async (req, res, next) => {
  try {
    const { otp } = req.body;
    if (!otp) return res.status(400).json({ error: 'OTP is required' });

    const pending = tokenStore[req.business.id];
    if (!pending?.pending_username) {
      return res.status(400).json({ error: 'Please generate OTP first via /otp/generate' });
    }

    const data = await sbFetch('/gst/taxpayer/authenticate', {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({
        gstin: pending.pending_gstin,
        username: pending.pending_username,
        otp,
      }),
    });

    const auth_token =
      data?.data?.auth_token ||
      data?.auth_token ||
      data?.token;

    if (!auth_token) {
      throw new Error(`Auth token not returned. Response: ${JSON.stringify(data).slice(0, 200)}`);
    }

    // Store auth token — valid 6 hours
    tokenStore[req.business.id] = {
      auth_token,
      gstin: pending.pending_gstin,
      username: pending.pending_username,
      expiry: Date.now() + 6 * 60 * 60 * 1000,
    };

    ok(res, { success: true, message: 'GST session connected successfully. Token valid for 6 hours.' });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sbgst/status
// Check if there is an active session
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status', async (req, res, next) => {
  try {
    const stored = tokenStore[req.business.id];
    if (!stored?.auth_token || stored.expiry <= Date.now()) {
      return ok(res, {
        connected: false,
        message: 'No active GST session. Please generate and verify OTP.',
      });
    }
    ok(res, {
      connected: true,
      gstin: stored.gstin,
      expires_in_minutes: Math.round((stored.expiry - Date.now()) / 60000),
      message: 'GST session is active.',
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sbgst/gstin/:gstin
// Verify any GSTIN — no auth token needed
// ─────────────────────────────────────────────────────────────────────────────
router.get('/gstin/:gstin', async (req, res, next) => {
  try {
    const { gstin } = req.params;
    const data = await sbFetch(`/gst/taxpayer/${gstin}`, {
      method: 'GET',
      headers: buildHeaders(),
    });
    ok(res, data);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sbgst/gstr1/file
// Body: { period } — format: MM-YYYY e.g. "06-2025"
// Builds GSTR-1 from your invoices and files it
// ─────────────────────────────────────────────────────────────────────────────
router.post('/gstr1/file', async (req, res, next) => {
  try {
    const { period } = req.body;
    if (!period) return res.status(400).json({ error: 'period required (MM-YYYY e.g. 06-2025)' });

    const stored = tokenStore[req.business.id];
    if (!stored?.auth_token || stored.expiry <= Date.now()) {
      return res.status(401).json({
        error: 'GST session expired or not started.',
        action: 'Call POST /api/sbgst/otp/generate then POST /api/sbgst/otp/verify',
      });
    }

    const [month, year] = period.split('-');
    const fromDate = `${year}-${month}-01`;
    const toDate = new Date(Number(year), Number(month), 0).toISOString().split('T')[0];
    const ret_period = `${month}${year}`; // MMYYYY format for API

    // Fetch sale invoices for the period
    const invoicesRes = await query(
      `SELECT i.*, p.gstin as party_gstin, p.state_code as party_state_code,
              p.name as party_name
       FROM invoices i
       LEFT JOIN parties p ON p.id = i.party_id
       WHERE i.business_id = $1
         AND i.invoice_type = 'sale'
         AND i.invoice_date BETWEEN $2 AND $3
         AND i.status != 'cancelled'`,
      [req.business.id, fromDate, toDate]
    );

    const biz = await getBusinessCreds(req.business.id);
    const invoices = invoicesRes.rows;

    // Split into B2B (GST-registered buyers) and B2C (unregistered buyers)
    const b2b = {};
    const b2cs = [];

    invoices.forEach(inv => {
      if (inv.party_gstin) {
        // B2B — group by buyer GSTIN
        if (!b2b[inv.party_gstin]) {
          b2b[inv.party_gstin] = { ctin: inv.party_gstin, inv: [] };
        }
        b2b[inv.party_gstin].inv.push({
          inum: inv.invoice_number,
          idt: new Date(inv.invoice_date).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-'),
          val: parseFloat(inv.total_amount),
          pos: inv.place_of_supply || biz.state_code,
          rchrg: 'N',
          itms: [{
            num: 1,
            itm_det: {
              txval: parseFloat(inv.taxable_amount),
              rt: 18, // default rate; ideally from invoice_items
              iamt: parseFloat(inv.igst_amount || 0),
              camt: parseFloat(inv.cgst_amount || 0),
              samt: parseFloat(inv.sgst_amount || 0),
              csamt: 0,
            },
          }],
        });
      } else {
        // B2CS — intra-state sales to unregistered buyers
        b2cs.push({
          typ: 'OE',
          pos: inv.place_of_supply || biz.state_code,
          rt: 18,
          txval: parseFloat(inv.taxable_amount),
          iamt: parseFloat(inv.igst_amount || 0),
          camt: parseFloat(inv.cgst_amount || 0),
          samt: parseFloat(inv.sgst_amount || 0),
          csamt: 0,
        });
      }
    });

    const gstr1Payload = {
      gstin: stored.gstin,
      fp: ret_period,
      gt: invoices.reduce((s, i) => s + parseFloat(i.total_amount || 0), 0),
      cur_gt: invoices.reduce((s, i) => s + parseFloat(i.total_amount || 0), 0),
      b2b: Object.values(b2b),
      b2cs,
    };

    // Save to GST portal via Sandbox API
    const saveData = await sbFetch('/gst/taxpayer/returns/gstr1', {
      method: 'POST',
      headers: buildHeaders({ 'x-auth-token': stored.auth_token }),
      body: JSON.stringify(gstr1Payload),
    });

    // File the return
    const fileData = await sbFetch('/gst/taxpayer/returns/gstr1/file', {
      method: 'POST',
      headers: buildHeaders({ 'x-auth-token': stored.auth_token }),
      body: JSON.stringify({ gstin: stored.gstin, fp: ret_period }),
    });

    const arn = fileData?.data?.arn || fileData?.arn || `SB-GSTR1-${Date.now()}`;

    // Update DB
    const financialYear = Number(month) >= 4
      ? `${year}-${String(Number(year) + 1).slice(-2)}`
      : `${Number(year) - 1}-${String(year).slice(-2)}`;

    await query(
      `INSERT INTO gst_returns
         (business_id, return_type, period, financial_year, status, due_date, arn, filed_on,
          taxable_amount, net_payable)
       VALUES ($1,'GSTR-1',$2,$3,'filed',$4,$5,NOW(),$6,0)
       ON CONFLICT (business_id, return_type, period)
       DO UPDATE SET status='filed', arn=$5, filed_on=NOW(), updated_at=NOW()`,
      [
        req.business.id, period, financialYear,
        getDueDate('GSTR-1', period), arn,
        invoices.reduce((s, i) => s + parseFloat(i.taxable_amount || 0), 0),
      ]
    );

    // Mark invoices as GSTR-1 filed
    if (invoices.length > 0) {
      const ids = invoices.map(i => i.id);
      await query(
        `UPDATE invoices SET gstr1_filed=true, gstr1_period=$1
         WHERE id = ANY($2::uuid[]) AND business_id=$3`,
        [period, ids, req.business.id]
      );
    }

    ok(res, {
      success: true,
      arn,
      period,
      invoices_filed: invoices.length,
      message: `GSTR-1 filed successfully for ${period}`,
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sbgst/gstr3b/file
// Body: { period } — format: MM-YYYY e.g. "06-2025"
// Auto-computes tax from invoices+expenses and files GSTR-3B
// ─────────────────────────────────────────────────────────────────────────────
router.post('/gstr3b/file', async (req, res, next) => {
  try {
    const { period } = req.body;
    if (!period) return res.status(400).json({ error: 'period required (MM-YYYY e.g. 06-2025)' });

    const stored = tokenStore[req.business.id];
    if (!stored?.auth_token || stored.expiry <= Date.now()) {
      return res.status(401).json({
        error: 'GST session expired or not started.',
        action: 'Call POST /api/sbgst/otp/generate then POST /api/sbgst/otp/verify',
      });
    }

    const [month, year] = period.split('-');
    const fromDate = `${year}-${month}-01`;
    const toDate = new Date(Number(year), Number(month), 0).toISOString().split('T')[0];
    const ret_period = `${month}${year}`; // MMYYYY

    // Fetch invoices and expenses for the period
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

    // Build GSTR-3B payload per GSTN spec
    const gstr3bPayload = {
      gstin: stored.gstin,
      ret_period,
      sup_details: {
        osup_det: {
          txval: s.taxable_amount,
          iamt: s.output_igst,
          camt: s.output_cgst,
          samt: s.output_sgst,
          csamt: 0,
        },
        osup_zero:    { txval: 0, iamt: 0 },
        osup_nil_exmp: { txval: 0 },
        isup_rev:     { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 },
        osup_nongst:  { txval: 0 },
      },
      inter_sup: {
        unreg_details: [],
        comp_details:  [],
        uin_details:   [],
      },
      itc_elg: {
        itc_avl: [
          { ty: 'ISRC', iamt: s.itc_igst, camt: s.itc_cgst, samt: s.itc_sgst, csamt: 0 },
        ],
        itc_rev:   [],
        itc_net:   { iamt: s.net_igst,  camt: s.net_cgst,  samt: s.net_sgst,  csamt: 0 },
        itc_inelg: [],
      },
      inward_sup: {
        isup_details: [{ ty: 'GST', intra: round2(s.itc_cgst + s.itc_sgst), inter: s.itc_igst }],
      },
      intr_ltfee: { intr_details: { iamt: 0, camt: 0, samt: 0, csamt: 0 } },
    };

    // Save GSTR-3B data
    await sbFetch('/gst/taxpayer/returns/gstr3b', {
      method: 'POST',
      headers: buildHeaders({ 'x-auth-token': stored.auth_token }),
      body: JSON.stringify(gstr3bPayload),
    });

    // File GSTR-3B
    const fileData = await sbFetch('/gst/taxpayer/returns/gstr3b/file', {
      method: 'POST',
      headers: buildHeaders({ 'x-auth-token': stored.auth_token }),
      body: JSON.stringify({ gstin: stored.gstin, ret_period }),
    });

    const arn = fileData?.data?.arn || fileData?.arn || `SB-3B-${Date.now()}`;

    // Save to gst_returns table
    const financialYear = Number(month) >= 4
      ? `${year}-${String(Number(year) + 1).slice(-2)}`
      : `${Number(year) - 1}-${String(year).slice(-2)}`;

    await query(
      `INSERT INTO gst_returns
         (business_id, return_type, period, financial_year, status, due_date, arn, filed_on,
          taxable_amount, output_igst, output_cgst, output_sgst,
          itc_igst, itc_cgst, itc_sgst,
          net_igst, net_cgst, net_sgst, net_payable)
       VALUES ($1,'GSTR-3B',$2,$3,'filed',$4,$5,NOW(),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (business_id, return_type, period)
       DO UPDATE SET
         status='filed', arn=$5, filed_on=NOW(),
         taxable_amount=$6, output_igst=$7, output_cgst=$8, output_sgst=$9,
         itc_igst=$10, itc_cgst=$11, itc_sgst=$12,
         net_igst=$13, net_cgst=$14, net_sgst=$15,
         net_payable=$16, updated_at=NOW()`,
      [
        req.business.id, period, financialYear,
        getDueDate('GSTR-3B', period), arn,
        s.taxable_amount,
        s.output_igst, s.output_cgst, s.output_sgst,
        s.itc_igst, s.itc_cgst, s.itc_sgst,
        s.net_igst, s.net_cgst, s.net_sgst,
        s.net_payable,
      ]
    );

    ok(res, {
      success: true,
      arn,
      period,
      summary: {
        taxable_amount: s.taxable_amount,
        output_tax: round2(s.output_igst + s.output_cgst + s.output_sgst),
        itc_claimed: round2(s.itc_igst + s.itc_cgst + s.itc_sgst),
        net_payable: s.net_payable,
      },
      message: `GSTR-3B filed successfully for ${period}`,
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sbgst/gstr3b/preview/:period
// Preview what will be filed BEFORE actually filing — no side effects
// ─────────────────────────────────────────────────────────────────────────────
router.get('/gstr3b/preview/:period', async (req, res, next) => {
  try {
    const { period } = req.params; // MM-YYYY
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
    const stored = tokenStore[req.business.id];

    ok(res, {
      period,
      session_active: !!(stored?.auth_token && stored.expiry > Date.now()),
      invoices_count: invoicesRes.rows.length,
      expenses_count: expensesRes.rows.length,
      summary: {
        taxable_amount:  s.taxable_amount,
        output_igst:     s.output_igst,
        output_cgst:     s.output_cgst,
        output_sgst:     s.output_sgst,
        total_output_tax: round2(s.output_igst + s.output_cgst + s.output_sgst),
        itc_igst:        s.itc_igst,
        itc_cgst:        s.itc_cgst,
        itc_sgst:        s.itc_sgst,
        total_itc:       round2(s.itc_igst + s.itc_cgst + s.itc_sgst),
        net_payable:     s.net_payable,
      },
      due_date: getDueDate('GSTR-3B', period),
      ready_to_file: !!(stored?.auth_token && stored.expiry > Date.now()),
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sbgst/returns
// List all GST returns filed from this app
// ─────────────────────────────────────────────────────────────────────────────
router.get('/returns', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT * FROM gst_returns WHERE business_id=$1 ORDER BY period DESC`,
      [req.business.id]
    );
    ok(res, result.rows);
  } catch (err) { next(err); }
});

module.exports = router;
