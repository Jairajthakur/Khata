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

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sbgst/sync
// Body: { period } — format: MM-YYYY e.g. "06-2025"
//
// Full GST Portal Sync — fetches from Sandbox.co.in:
//   • GSTR-1 (your outward sales) → auto-creates parties + sale invoices
//   • GSTR-2A (inward purchases from suppliers) → auto-creates parties + expenses
//
// Requires active auth token (call /otp/generate → /otp/verify first).
// Safe to call multiple times — uses ON CONFLICT to skip duplicates.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/sync', async (req, res, next) => {
  const { getClient } = require('../config/db');
  const client = await getClient();
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
    const ret_period = `${month}${year}`; // MMYYYY for Sandbox API
    const biz = await getBusinessCreds(req.business.id);

    await client.query('BEGIN');

    // ── Helper: upsert a party by GSTIN (or by name if no GSTIN) ──────────
    async function upsertParty({ name, gstin, mobile, address, state_code, party_type }) {
      if (gstin) {
        // Try to find by GSTIN first
        const existing = await client.query(
          `SELECT id FROM parties WHERE business_id=$1 AND gstin=$2 LIMIT 1`,
          [req.business.id, gstin]
        );
        if (existing.rows.length) return existing.rows[0].id;
        // Insert new
        const inserted = await client.query(
          `INSERT INTO parties (business_id, name, gstin, mobile, address, state_code, party_type, opening_balance)
           VALUES ($1,$2,$3,$4,$5,$6,$7,0) RETURNING id`,
          [req.business.id, name || gstin, gstin, mobile || null, address || null, state_code || null, party_type]
        );
        return inserted.rows[0].id;
      } else {
        // No GSTIN — match by exact name
        const existing = await client.query(
          `SELECT id FROM parties WHERE business_id=$1 AND name ILIKE $2 LIMIT 1`,
          [req.business.id, name]
        );
        if (existing.rows.length) return existing.rows[0].id;
        const inserted = await client.query(
          `INSERT INTO parties (business_id, name, party_type, opening_balance)
           VALUES ($1,$2,$3,0) RETURNING id`,
          [req.business.id, name, party_type]
        );
        return inserted.rows[0].id;
      }
    }

    // ── Helper: parse DD-MM-YYYY or DDMMYYYY → YYYY-MM-DD ─────────────────
    function parseGSTDate(raw) {
      if (!raw) return new Date().toISOString().split('T')[0];
      if (/^\d{8}$/.test(raw)) {
        // DDMMYYYY
        return `${raw.slice(4)}-${raw.slice(2, 4)}-${raw.slice(0, 2)}`;
      }
      if (raw.includes('-') && raw.length === 10) {
        const [d, m, y] = raw.split('-');
        if (y && m && d) return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
      }
      return new Date().toISOString().split('T')[0];
    }

    // ────────────────────────────────────────────────────────────────────────
    // PART 1: GSTR-1 — fetch YOUR outward sales from GST portal
    // API: GET /gst/taxpayer/returns/gstr1?gstin=&ret_period=
    // ────────────────────────────────────────────────────────────────────────
    let gstr1Data = null;
    let gstr1Error = null;
    let invoicesCreated = 0;
    let invoicesSkipped = 0;

    try {
      gstr1Data = await sbFetch(
        `/gst/taxpayer/returns/gstr1?gstin=${stored.gstin}&ret_period=${ret_period}`,
        {
          method: 'GET',
          headers: buildHeaders({ 'x-auth-token': stored.auth_token }),
        }
      );
    } catch (e) {
      gstr1Error = e.message;
    }

    if (gstr1Data) {
      // GSTR-1 B2B invoices (GST-registered buyers)
      const b2bEntries = gstr1Data?.data?.b2b || gstr1Data?.b2b || [];
      for (const buyer of b2bEntries) {
        const buyerGstin = buyer.ctin;
        const buyerName  = buyer.trdnm || buyer.tradeName || buyerGstin;
        const stateCode  = buyerGstin ? buyerGstin.slice(0, 2) : null;

        const partyId = await upsertParty({
          name: buyerName,
          gstin: buyerGstin,
          state_code: stateCode,
          party_type: 'customer',
        });

        const invoices = buyer.inv || [];
        for (const inv of invoices) {
          const invoiceNumber = inv.inum;
          const invoiceDate   = parseGSTDate(inv.idt);
          const totalAmount   = parseFloat(inv.val || 0);
          const placeOfSupply = inv.pos || stateCode || biz.state_code;
          const isIgst        = placeOfSupply !== biz.state_code;

          // Compute tax from items
          let taxableAmount = 0, igst = 0, cgst = 0, sgst = 0;
          const items = inv.itms || [];
          items.forEach(itm => {
            const d = itm.itm_det || itm;
            taxableAmount += parseFloat(d.txval || 0);
            igst          += parseFloat(d.iamt  || 0);
            cgst          += parseFloat(d.camt  || 0);
            sgst          += parseFloat(d.samt  || 0);
          });
          const totalTax = round2(igst + cgst + sgst);

          // Skip if invoice_number already exists for this business
          const dup = await client.query(
            `SELECT id FROM invoices WHERE business_id=$1 AND invoice_number=$2 LIMIT 1`,
            [req.business.id, invoiceNumber]
          );
          if (dup.rows.length) { invoicesSkipped++; continue; }

          const invRes = await client.query(
            `INSERT INTO invoices
               (business_id, party_id, invoice_number, invoice_type, invoice_date,
                place_of_supply, is_igst, subtotal, discount_amount, taxable_amount,
                igst_amount, cgst_amount, sgst_amount, total_tax, total_amount, status, notes)
             VALUES ($1,$2,$3,'sale',$4,$5,$6,$7,0,$8,$9,$10,$11,$12,$13,'unpaid','Synced from GST portal')
             RETURNING id`,
            [
              req.business.id, partyId, invoiceNumber, invoiceDate,
              placeOfSupply, isIgst,
              totalAmount, taxableAmount,
              igst, cgst, sgst, totalTax,
              totalAmount,
            ]
          );
          const newInvId = invRes.rows[0].id;

          // Insert a single line item summarising the invoice
          if (items.length > 0) {
            const d = items[0].itm_det || items[0];
            await client.query(
              `INSERT INTO invoice_items
                 (invoice_id, description, quantity, unit, rate, taxable_amount,
                  gst_rate, igst_amount, cgst_amount, sgst_amount, total_amount)
               VALUES ($1,$2,1,'pcs',$3,$4,$5,$6,$7,$8,$9)`,
              [
                newInvId,
                inv.itm?.[0]?.itm_det?.nm || 'GST Portal Item',
                taxableAmount,
                taxableAmount,
                parseFloat(d.rt || 18),
                parseFloat(d.iamt || 0),
                parseFloat(d.camt || 0),
                parseFloat(d.samt || 0),
                totalAmount,
              ]
            );
          }

          // Khata credit entry
          await client.query(
            `INSERT INTO khata_entries
               (business_id, party_id, entry_date, entry_type, amount, description, reference_type, reference_id)
             VALUES ($1,$2,$3,'credit',$4,$5,'invoice',$6)`,
            [req.business.id, partyId, invoiceDate, totalAmount, `GST Sync — ${invoiceNumber}`, newInvId]
          );

          invoicesCreated++;
        }
      }

      // GSTR-1 B2CS (unregistered buyers) — create a single "B2C Sales" party entry
      const b2cs = gstr1Data?.data?.b2cs || gstr1Data?.b2cs || [];
      if (b2cs.length > 0) {
        let b2cPartyId = null;
        const b2cExist = await client.query(
          `SELECT id FROM parties WHERE business_id=$1 AND name='B2C (Unregistered Buyers)' LIMIT 1`,
          [req.business.id]
        );
        if (b2cExist.rows.length) {
          b2cPartyId = b2cExist.rows[0].id;
        } else {
          const inserted = await client.query(
            `INSERT INTO parties (business_id, name, party_type, opening_balance)
             VALUES ($1,'B2C (Unregistered Buyers)','customer',0) RETURNING id`,
            [req.business.id]
          );
          b2cPartyId = inserted.rows[0].id;
        }

        for (const entry of b2cs) {
          const invoiceDate = new Date().toISOString().split('T')[0];
          const taxable = parseFloat(entry.txval || 0);
          const igst    = parseFloat(entry.iamt  || 0);
          const cgst    = parseFloat(entry.camt  || 0);
          const sgst    = parseFloat(entry.samt  || 0);
          const total   = round2(taxable + igst + cgst + sgst);
          const b2cNum  = `B2C-${ret_period}-${entry.pos || 'XX'}`;

          const dup = await client.query(
            `SELECT id FROM invoices WHERE business_id=$1 AND invoice_number=$2 LIMIT 1`,
            [req.business.id, b2cNum]
          );
          if (!dup.rows.length) {
            await client.query(
              `INSERT INTO invoices
                 (business_id, party_id, invoice_number, invoice_type, invoice_date,
                  place_of_supply, is_igst, subtotal, discount_amount, taxable_amount,
                  igst_amount, cgst_amount, sgst_amount, total_tax, total_amount, status, notes)
               VALUES ($1,$2,$3,'sale',$4,$5,$6,$7,0,$8,$9,$10,$11,$12,$13,'paid','B2C aggregate — GST sync')`,
              [
                req.business.id, b2cPartyId, b2cNum, invoiceDate,
                entry.pos || biz.state_code, igst > 0 && cgst === 0,
                total, taxable, igst, cgst, sgst, round2(igst + cgst + sgst), total,
              ]
            );
            invoicesCreated++;
          } else {
            invoicesSkipped++;
          }
        }
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // PART 2: GSTR-2A — fetch purchase invoices from your SUPPLIERS
    // API: GET /gst/taxpayer/returns/gstr2a?gstin=&ret_period=
    // These become expenses (purchases) in your books.
    // ────────────────────────────────────────────────────────────────────────
    let gstr2aData = null;
    let gstr2aError = null;
    let expensesCreated = 0;
    let expensesSkipped = 0;
    let partiesCreated = 0;

    try {
      gstr2aData = await sbFetch(
        `/gst/taxpayer/returns/gstr2a?gstin=${stored.gstin}&ret_period=${ret_period}`,
        {
          method: 'GET',
          headers: buildHeaders({ 'x-auth-token': stored.auth_token }),
        }
      );
    } catch (e) {
      gstr2aError = e.message;
    }

    if (gstr2aData) {
      const suppliers = gstr2aData?.data?.b2b || gstr2aData?.b2b || [];

      for (const supplier of suppliers) {
        const supplierGstin = supplier.ctin;
        const supplierName  = supplier.trdnm || supplier.tradeName || supplierGstin;
        const stateCode     = supplierGstin ? supplierGstin.slice(0, 2) : null;

        // Count existing parties to detect if we create a new one
        const existCheck = await client.query(
          `SELECT id FROM parties WHERE business_id=$1 AND gstin=$2 LIMIT 1`,
          [req.business.id, supplierGstin]
        );
        if (!existCheck.rows.length) partiesCreated++;

        const supplierId = await upsertParty({
          name: supplierName,
          gstin: supplierGstin,
          state_code: stateCode,
          party_type: 'supplier',
        });

        const invoices = supplier.inv || [];
        for (const inv of invoices) {
          const invoiceNum  = inv.inum;
          const invoiceDate = parseGSTDate(inv.idt);
          const totalVal    = parseFloat(inv.val || 0);

          let taxableAmount = 0, igst = 0, cgst = 0, sgst = 0;
          (inv.itms || []).forEach(itm => {
            const d = itm.itm_det || itm;
            taxableAmount += parseFloat(d.txval || 0);
            igst          += parseFloat(d.iamt  || 0);
            cgst          += parseFloat(d.camt  || 0);
            sgst          += parseFloat(d.samt  || 0);
          });
          const gstAmount = round2(igst + cgst + sgst);
          const totalAmount = round2(taxableAmount + gstAmount) || totalVal;

          // Deduplicate by vendor reference number + party
          const dup = await client.query(
            `SELECT id FROM expenses
             WHERE business_id=$1 AND party_id=$2 AND vendor_invoice=$3 LIMIT 1`,
            [req.business.id, supplierId, invoiceNum]
          );
          if (dup.rows.length) { expensesSkipped++; continue; }

          await client.query(
            `INSERT INTO expenses
               (business_id, party_id, expense_date, category, description,
                amount, gst_rate, gst_amount, total_amount,
                itc_eligible, gstr2a_matched, payment_mode, vendor_invoice)
             VALUES ($1,$2,$3,'Purchase',$4,$5,$6,$7,$8,true,true,'credit',$9)`,
            [
              req.business.id, supplierId, invoiceDate,
              `GSTR-2A sync — ${supplierName} (${invoiceNum})`,
              taxableAmount,
              (inv.itms?.[0]?.itm_det?.rt || 18),
              gstAmount,
              totalAmount,
              invoiceNum,
            ]
          );
          expensesCreated++;
        }
      }
    }

    await client.query('COMMIT');

    // ── Log the sync ──────────────────────────────────────────────────────
    await query(
      `INSERT INTO activity_log (business_id, user_id, action, entity_type, description)
       VALUES ($1,$2,'gst_portal_sync','sync',$3)`,
      [
        req.business.id,
        req.user.id,
        `GST Sync for ${period}: ${invoicesCreated} invoices, ${expensesCreated} expenses, ${partiesCreated} new parties`,
      ]
    );

    ok(res, {
      success: true,
      period,
      gstr1: {
        fetched: !gstr1Error,
        error: gstr1Error || null,
        invoices_created: invoicesCreated,
        invoices_skipped: invoicesSkipped,
      },
      gstr2a: {
        fetched: !gstr2aError,
        error: gstr2aError || null,
        expenses_created: expensesCreated,
        expenses_skipped: expensesSkipped,
        parties_created: partiesCreated,
      },
      message: `Sync complete! ${invoicesCreated} invoices and ${expensesCreated} expenses imported from GST portal.`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
