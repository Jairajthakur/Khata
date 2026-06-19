const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, requireBusiness } = require('../middleware/auth');
const { ok, created } = require('../middleware/errorHandler');
const { round2 } = require('../utils/gstCalculator');

router.use(authenticate, requireBusiness);

// GET /api/expenses — list with filters
router.get('/', async (req, res, next) => {
  try {
    const { category, from, to, payment_mode, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let sql = `
      SELECT e.*, p.name as party_name
      FROM expenses e
      LEFT JOIN parties p ON p.id = e.party_id
      WHERE e.business_id = $1
    `;
    const vals = [req.business.id];
    let idx = 2;

    if (category)     { sql += ` AND e.category = $${idx++}`;     vals.push(category); }
    if (payment_mode)  { sql += ` AND e.payment_mode = $${idx++}`; vals.push(payment_mode); }
    if (from)          { sql += ` AND e.expense_date >= $${idx++}`; vals.push(from); }
    if (to)            { sql += ` AND e.expense_date <= $${idx++}`; vals.push(to); }

    const countResult = await query(sql.replace('SELECT e.*, p.name as party_name', 'SELECT COUNT(*)'), vals);
    sql += ` ORDER BY e.expense_date DESC LIMIT $${idx++} OFFSET $${idx}`;
    vals.push(parseInt(limit)); vals.push(offset);

    const result = await query(sql, vals);
    ok(res, result.rows, { total: parseInt(countResult.rows[0].count), page: parseInt(page), limit: parseInt(limit) });
  } catch (err) { next(err); }
});

// GET /api/expenses/stats — totals for a period, split GST vs non-GST, by category
router.get('/stats', async (req, res, next) => {
  try {
    const { month, year } = req.query;
    const period = month && year
      ? `AND EXTRACT(MONTH FROM expense_date)=${parseInt(month)} AND EXTRACT(YEAR FROM expense_date)=${parseInt(year)}`
      : '';

    const totals = await query(`
      SELECT
        COUNT(*) as total_entries,
        SUM(total_amount) as total_amount,
        SUM(CASE WHEN gst_amount > 0 THEN total_amount ELSE 0 END) as gst_expenses,
        SUM(CASE WHEN gst_amount = 0 THEN total_amount ELSE 0 END) as non_gst_expenses,
        SUM(CASE WHEN itc_eligible THEN gst_amount ELSE 0 END) as itc_claimable
      FROM expenses
      WHERE business_id = $1 ${period}
    `, [req.business.id]);

    const byCategory = await query(`
      SELECT category, COUNT(*) as count, SUM(total_amount) as total
      FROM expenses
      WHERE business_id = $1 ${period}
      GROUP BY category
      ORDER BY total DESC
    `, [req.business.id]);

    ok(res, { ...totals.rows[0], by_category: byCategory.rows });
  } catch (err) { next(err); }
});

// GET /api/expenses/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT e.*, p.name as party_name FROM expenses e LEFT JOIN parties p ON p.id = e.party_id
       WHERE e.id = $1 AND e.business_id = $2`,
      [req.params.id, req.business.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Expense not found' });
    ok(res, result.rows[0]);
  } catch (err) { next(err); }
});

// POST /api/expenses
router.post('/', async (req, res, next) => {
  try {
    const {
      party_id, expense_date, category, description,
      vendor_name, vendor_gstin, vendor_invoice,
      amount, gst_rate = 0, itc_eligible = false, payment_mode = 'cash',
    } = req.body;

    if (!expense_date || !category || amount === undefined) {
      return res.status(400).json({ error: 'expense_date, category and amount are required' });
    }

    const gst_amount = round2((parseFloat(amount) * parseFloat(gst_rate)) / 100);
    const total_amount = round2(parseFloat(amount) + gst_amount);

    const result = await query(
      `INSERT INTO expenses (business_id, party_id, expense_date, category, description,
        vendor_name, vendor_gstin, vendor_invoice, amount, gst_rate, gst_amount, total_amount,
        itc_eligible, payment_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [req.business.id, party_id || null, expense_date, category, description || null,
       vendor_name || null, vendor_gstin || null, vendor_invoice || null,
       amount, gst_rate, gst_amount, total_amount, !!itc_eligible, payment_mode]
    );
    const expense = result.rows[0];

    // If tied to a supplier party, reflect it on the khata ledger (money owed to supplier)
    if (party_id) {
      await query(
        `INSERT INTO khata_entries (business_id, party_id, entry_date, entry_type, amount, description, reference_type, reference_id)
         VALUES ($1,$2,$3,'debit',$4,$5,'expense',$6)`,
        [req.business.id, party_id, expense_date, total_amount, `Expense — ${category}`, expense.id]
      );
    }

    await query(
      `INSERT INTO activity_log (business_id, user_id, action, entity_type, entity_id, description)
       VALUES ($1,$2,'expense_created','expense',$3,$4)`,
      [req.business.id, req.user.id, expense.id, `${category} expense of ₹${total_amount} recorded`]
    );

    created(res, expense);
  } catch (err) { next(err); }
});

// PATCH /api/expenses/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const fields = ['party_id','expense_date','category','description','vendor_name','vendor_gstin',
      'vendor_invoice','amount','gst_rate','itc_eligible','payment_mode','gstr2a_matched'];
    const updates = []; const vals = []; let i = 1;
    fields.forEach(f => { if (req.body[f] !== undefined) { updates.push(`${f} = $${i++}`); vals.push(req.body[f]); } });

    // Recompute derived totals if amount or gst_rate changed
    if (req.body.amount !== undefined || req.body.gst_rate !== undefined) {
      const existing = await query('SELECT amount, gst_rate FROM expenses WHERE id = $1 AND business_id = $2', [req.params.id, req.business.id]);
      if (!existing.rows.length) return res.status(404).json({ error: 'Expense not found' });
      const amount = req.body.amount !== undefined ? parseFloat(req.body.amount) : parseFloat(existing.rows[0].amount);
      const gstRate = req.body.gst_rate !== undefined ? parseFloat(req.body.gst_rate) : parseFloat(existing.rows[0].gst_rate);
      const gst_amount = round2((amount * gstRate) / 100);
      const total_amount = round2(amount + gst_amount);
      updates.push(`gst_amount = $${i++}`); vals.push(gst_amount);
      updates.push(`total_amount = $${i++}`); vals.push(total_amount);
    }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id); vals.push(req.business.id);

    const result = await query(
      `UPDATE expenses SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${i++} AND business_id = $${i} RETURNING *`,
      vals
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Expense not found' });
    ok(res, result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/expenses/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await query('DELETE FROM expenses WHERE id = $1 AND business_id = $2 RETURNING id', [req.params.id, req.business.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Expense not found' });
    ok(res, { message: 'Expense deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
