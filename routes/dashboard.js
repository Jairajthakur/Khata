const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, requireBusiness } = require('../middleware/auth');
const { ok } = require('../middleware/errorHandler');
const { round2 } = require('../utils/gstCalculator');

router.use(authenticate, requireBusiness);

router.get('/summary', async (req, res, next) => {
  try {
    const businessId = req.business.id;

    const salesRes = await query(
      `SELECT COALESCE(SUM(total_amount), 0) as total FROM invoices
         WHERE business_id = $1 AND invoice_type = 'sale'
         AND invoice_date = CURRENT_DATE AND status != 'cancelled'`,
      [businessId]
    );
    const expensesRes = await query(
      `SELECT COALESCE(SUM(total_amount), 0) as total FROM expenses
         WHERE business_id = $1 AND expense_date = CURRENT_DATE`,
      [businessId]
    );
    const cashRes = await query(
      `SELECT
         COALESCE(SUM(CASE WHEN payment_mode = 'cash' AND payment_type = 'received' THEN amount ELSE 0 END), 0)
         - COALESCE(SUM(CASE WHEN payment_mode = 'cash' AND payment_type = 'made' THEN amount ELSE 0 END), 0) as cash
       FROM payments WHERE business_id = $1`,
      [businessId]
    );
    const pendingRes = await query(
      `SELECT COALESCE(SUM(total_amount - paid_amount), 0) as pending FROM invoices
         WHERE business_id = $1 AND status IN ('unpaid','partial','overdue')`,
      [businessId]
    );

    ok(res, {
      date: new Date().toISOString().split('T')[0],
      sales: round2(parseFloat(salesRes.rows[0].total)),
      expenses: round2(parseFloat(expensesRes.rows[0].total)),
      cash: round2(parseFloat(cashRes.rows[0].cash)),
      pending: round2(parseFloat(pendingRes.rows[0].pending)),
    });
  } catch (err) { next(err); }
});

router.get('/outstanding', async (req, res, next) => {
  try {
    const businessId = req.business.id;
    const toReceiveRes = await query(
      `SELECT COALESCE(SUM(total_amount - paid_amount), 0) as total FROM invoices
         WHERE business_id = $1 AND invoice_type = 'sale' AND status IN ('unpaid','partial','overdue')`,
      [businessId]
    );
    const toPayRes = await query(
      `SELECT COALESCE(SUM(total_amount - paid_amount), 0) as total FROM invoices
         WHERE business_id = $1 AND invoice_type = 'purchase' AND status IN ('unpaid','partial','overdue')`,
      [businessId]
    );
    const toReceive = round2(parseFloat(toReceiveRes.rows[0].total));
    const toPay = round2(parseFloat(toPayRes.rows[0].total));
    ok(res, { toReceive, toPay, net: round2(toReceive - toPay) });
  } catch (err) { next(err); }
});

router.get('/revenue-trend', async (req, res, next) => {
  try {
    const months = Math.min(parseInt(req.query.months) || 6, 24);
    const result = await query(
      `SELECT to_char(date_trunc('month', invoice_date), 'YYYY-MM') as month,
              COALESCE(SUM(total_amount), 0) as sales
       FROM invoices
       WHERE business_id = $1 AND invoice_type = 'sale' AND status != 'cancelled'
         AND invoice_date >= (CURRENT_DATE - INTERVAL '1 month' * $2)
       GROUP BY 1 ORDER BY 1`,
      [req.business.id, months]
    );
    ok(res, result.rows.map(r => ({ month: r.month, sales: round2(parseFloat(r.sales)) })));
  } catch (err) { next(err); }
});

router.get('/top-parties', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 5, 50);
    const result = await query(
      `SELECT p.id, p.name, p.party_type, COALESCE(SUM(i.total_amount), 0) as turnover
       FROM parties p
       JOIN invoices i ON i.party_id = p.id
       WHERE p.business_id = $1 AND i.status != 'cancelled'
       GROUP BY p.id, p.name, p.party_type
       ORDER BY turnover DESC
       LIMIT $2`,
      [req.business.id, limit]
    );
    ok(res, result.rows.map(r => ({ ...r, turnover: round2(parseFloat(r.turnover)) })));
  } catch (err) { next(err); }
});

router.get('/recent-activity', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const result = await query(
      `SELECT * FROM activity_log WHERE business_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [req.business.id, limit]
    );
    ok(res, result.rows);
  } catch (err) { next(err); }
});

module.exports = router;
