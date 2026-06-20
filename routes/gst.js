const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, requireBusiness } = require('../middleware/auth');
const { ok, created } = require('../middleware/errorHandler');
const { computeGSTR3B, getDueDate, round2 } = require('../utils/gstCalculator');

router.use(authenticate, requireBusiness);

// GET /api/gst/returns
router.get('/returns', async (req, res, next) => {
  try {
    const { return_type, financial_year } = req.query;
    let sql = `SELECT * FROM gst_returns WHERE business_id = $1`;
    const params = [req.business.id];
    let i = 2;
    if (return_type) { sql += ` AND return_type = $${i++}`; params.push(return_type); }
    if (financial_year) { sql += ` AND financial_year = $${i++}`; params.push(financial_year); }
    sql += ` ORDER BY period DESC`;
    const result = await query(sql, params);
    ok(res, result.rows);
  } catch (err) { next(err); }
});

// GET /api/gst/returns/:id
router.get('/returns/:id', async (req, res, next) => {
  try {
    const result = await query(
      'SELECT * FROM gst_returns WHERE id = $1 AND business_id = $2',
      [req.params.id, req.business.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'GST return not found' });
    ok(res, result.rows[0]);
  } catch (err) { next(err); }
});

// POST /api/gst/returns/generate  body: { return_type, period: 'MM-YYYY' }
router.post('/returns/generate', async (req, res, next) => {
  try {
    const { return_type = 'GSTR-3B', period } = req.body;
    if (!period) return res.status(400).json({ error: 'period (MM-YYYY) is required' });

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

    const summary = computeGSTR3B(invoicesRes.rows, expensesRes.rows);
    const dueDate = getDueDate(return_type, period);
    const financialYear = Number(month) >= 4
      ? `${year}-${String(Number(year) + 1).slice(-2)}`
      : `${Number(year) - 1}-${String(year).slice(-2)}`;

    const result = await query(
      `INSERT INTO gst_returns
         (business_id, return_type, period, financial_year, status, due_date,
          taxable_amount, output_igst, output_cgst, output_sgst,
          itc_igst, itc_cgst, itc_sgst, net_igst, net_cgst, net_sgst, net_payable)
       VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (business_id, return_type, period)
       DO UPDATE SET
         taxable_amount = EXCLUDED.taxable_amount,
         output_igst = EXCLUDED.output_igst, output_cgst = EXCLUDED.output_cgst, output_sgst = EXCLUDED.output_sgst,
         itc_igst = EXCLUDED.itc_igst, itc_cgst = EXCLUDED.itc_cgst, itc_sgst = EXCLUDED.itc_sgst,
         net_igst = EXCLUDED.net_igst, net_cgst = EXCLUDED.net_cgst, net_sgst = EXCLUDED.net_sgst,
         net_payable = EXCLUDED.net_payable, updated_at = NOW()
       RETURNING *`,
      [
        req.business.id, return_type, period, financialYear, dueDate,
        summary.taxable_amount, summary.output_igst, summary.output_cgst, summary.output_sgst,
        summary.itc_igst, summary.itc_cgst, summary.itc_sgst,
        summary.net_igst, summary.net_cgst, summary.net_sgst, summary.net_payable,
      ]
    );
    created(res, result.rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/gst/returns/:id/file
router.patch('/returns/:id/file', async (req, res, next) => {
  try {
    const { arn } = req.body;
    const result = await query(
      `UPDATE gst_returns SET status = 'filed', arn = $1, filed_on = NOW(), updated_at = NOW()
       WHERE id = $2 AND business_id = $3 RETURNING *`,
      [arn || null, req.params.id, req.business.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'GST return not found' });
    ok(res, result.rows[0]);
  } catch (err) { next(err); }
});

// GET /api/gst/due
router.get('/due', async (req, res, next) => {
  try {
    const now = new Date();
    const period = `${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`;
    const result = await query(
      `SELECT * FROM gst_returns WHERE business_id = $1 AND return_type = 'GSTR-3B' AND period = $2`,
      [req.business.id, period]
    );
    if (!result.rows.length) {
      return ok(res, { period, net_payable: 0, due_date: getDueDate('GSTR-3B', period), filed: false });
    }
    const ret = result.rows[0];
    ok(res, {
      period: ret.period,
      net_payable: round2(ret.net_payable),
      due_date: ret.due_date,
      filed: ret.status === 'filed',
    });
  } catch (err) { next(err); }
});

module.exports = router;
