const express = require('express');
const router = express.Router();
const { query, getClient } = require('../config/db');
const { authenticate, requireBusiness } = require('../middleware/auth');
const { ok, created } = require('../middleware/errorHandler');
const { computeItemTax, computeInvoiceTotals, isInterState } = require('../utils/gstCalculator');

router.use(authenticate, requireBusiness);

// GET /api/invoices
router.get('/', async (req, res, next) => {
  try {
    const { status, type, from, to, party_id, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let sql = `
      SELECT i.*, p.name as party_name, p.gstin as party_gstin
      FROM invoices i
      LEFT JOIN parties p ON p.id = i.party_id
      WHERE i.business_id = $1
    `;
    const vals = [req.business.id];
    let idx = 2;

    if (status)   { sql += ` AND i.status = $${idx++}`;       vals.push(status); }
    if (type)     { sql += ` AND i.invoice_type = $${idx++}`; vals.push(type); }
    if (party_id) { sql += ` AND i.party_id = $${idx++}`;     vals.push(party_id); }
    if (from)     { sql += ` AND i.invoice_date >= $${idx++}`; vals.push(from); }
    if (to)       { sql += ` AND i.invoice_date <= $${idx++}`; vals.push(to); }

    const countResult = await query(sql.replace('SELECT i.*, p.name as party_name, p.gstin as party_gstin', 'SELECT COUNT(*)'), vals);
    sql += ` ORDER BY i.invoice_date DESC LIMIT $${idx++} OFFSET $${idx}`;
    vals.push(parseInt(limit)); vals.push(offset);

    const result = await query(sql, vals);
    ok(res, result.rows, { total: parseInt(countResult.rows[0].count), page: parseInt(page), limit: parseInt(limit) });
  } catch (err) { next(err); }
});

// GET /api/invoices/stats — dashboard numbers
router.get('/stats', async (req, res, next) => {
  try {
    const { month, year } = req.query;
    const period = month && year ? `AND EXTRACT(MONTH FROM invoice_date)=${month} AND EXTRACT(YEAR FROM invoice_date)=${year}` : '';

    const result = await query(`
      SELECT
        COUNT(*) as total,
        SUM(total_amount) as total_amount,
        SUM(CASE WHEN status='paid' THEN total_amount ELSE 0 END) as collected,
        SUM(CASE WHEN status IN ('unpaid','partial','overdue') THEN total_amount - paid_amount ELSE 0 END) as pending,
        SUM(cgst_amount) as total_cgst,
        SUM(sgst_amount) as total_sgst,
        SUM(igst_amount) as total_igst
      FROM invoices
      WHERE business_id = $1 AND invoice_type = 'sale' ${period}
    `, [req.business.id]);

    ok(res, result.rows[0]);
  } catch (err) { next(err); }
});

// GET /api/invoices/:id
router.get('/:id', async (req, res, next) => {
  try {
    const inv = await query(
      `SELECT i.*, p.name as party_name, p.gstin as party_gstin, p.mobile as party_mobile, p.address as party_address
       FROM invoices i LEFT JOIN parties p ON p.id = i.party_id
       WHERE i.id = $1 AND i.business_id = $2`,
      [req.params.id, req.business.id]
    );
    if (!inv.rows.length) return res.status(404).json({ error: 'Invoice not found' });

    const items = await query('SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY created_at', [req.params.id]);
    ok(res, { ...inv.rows[0], items: items.rows });
  } catch (err) { next(err); }
});

// POST /api/invoices
router.post('/', async (req, res, next) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const {
      party_id, invoice_date, due_date, place_of_supply,
      invoice_type = 'sale', notes,
      items = [], // [{description, hsn_sac, quantity, unit, rate, discount_pct, gst_rate}]
    } = req.body;

    if (!items.length) return res.status(400).json({ error: 'At least one item required' });
    if (!invoice_date) return res.status(400).json({ error: 'Invoice date required' });

    // Auto-generate invoice number
    const countRes = await client.query(
      `SELECT COUNT(*) FROM invoices WHERE business_id = $1 AND invoice_type = $2`,
      [req.business.id, invoice_type]
    );
    const prefix = invoice_type === 'sale' ? 'INV' : 'PUR';
    const year = new Date(invoice_date).getFullYear();
    const num = String(parseInt(countRes.rows[0].count) + 1).padStart(4, '0');
    const invoice_number = `${prefix}-${year}-${num}`;

    // Determine inter-state
    let partyStateCode = null;
    if (party_id) {
      const partyRes = await client.query('SELECT state_code FROM parties WHERE id = $1', [party_id]);
      partyStateCode = partyRes.rows[0]?.state_code;
    }
    const supplyState = place_of_supply || partyStateCode;
    const is_igst = isInterState(req.business.state_code, supplyState);

    // Compute each item
    const computedItems = items.map(item => ({
      ...item,
      ...computeItemTax(
        parseFloat(item.rate),
        parseFloat(item.quantity || 1),
        parseFloat(item.discount_pct || 0),
        parseFloat(item.gst_rate || 18),
        is_igst
      ),
    }));

    const totals = computeInvoiceTotals(computedItems, is_igst);

    // Insert invoice
    const invRes = await client.query(
      `INSERT INTO invoices (business_id, party_id, invoice_number, invoice_type, invoice_date, due_date,
        place_of_supply, is_igst, subtotal, discount_amount, taxable_amount,
        igst_amount, cgst_amount, sgst_amount, total_tax, total_amount, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'unpaid',$17)
       RETURNING *`,
      [
        req.business.id, party_id, invoice_number, invoice_type, invoice_date, due_date || null,
        supplyState, is_igst, totals.subtotal, totals.discount_amount, totals.taxable_amount,
        totals.igst_amount, totals.cgst_amount, totals.sgst_amount, totals.total_tax, totals.total_amount, notes,
      ]
    );
    const invoice = invRes.rows[0];

    // Insert items
    for (const item of computedItems) {
      await client.query(
        `INSERT INTO invoice_items (invoice_id, description, hsn_sac, quantity, unit, rate,
          discount_pct, taxable_amount, gst_rate, igst_amount, cgst_amount, sgst_amount, total_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [invoice.id, item.description, item.hsn_sac, item.quantity || 1, item.unit || 'pcs',
         item.rate, item.discount_pct || 0, item.taxable_amount, item.gst_rate,
         item.igst_amount, item.cgst_amount, item.sgst_amount, item.total_amount]
      );
    }

    // Create khata entry for sale
    if (invoice_type === 'sale' && party_id) {
      await client.query(
        `INSERT INTO khata_entries (business_id, party_id, entry_date, entry_type, amount, description, reference_type, reference_id)
         VALUES ($1,$2,$3,'credit',$4,$5,'invoice',$6)`,
        [req.business.id, party_id, invoice_date, totals.total_amount, `Invoice ${invoice_number}`, invoice.id]
      );
    }

    // Activity log
    await client.query(
      `INSERT INTO activity_log (business_id, user_id, action, entity_type, entity_id, description)
       VALUES ($1,$2,'invoice_created','invoice',$3,$4)`,
      [req.business.id, req.user.id, invoice.id, `${invoice_number} created — ₹${totals.total_amount}`]
    );

    await client.query('COMMIT');
    created(res, { ...invoice, items: computedItems });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// PATCH /api/invoices/:id/status
router.patch('/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body;
    const valid = ['paid','unpaid','partial','overdue','cancelled'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const result = await query(
      `UPDATE invoices SET status = $1, updated_at = NOW() WHERE id = $2 AND business_id = $3 RETURNING *`,
      [status, req.params.id, req.business.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Invoice not found' });
    ok(res, result.rows[0]);
  } catch (err) { next(err); }
});

// POST /api/invoices/:id/payment
router.post('/:id/payment', async (req, res, next) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { amount, payment_date, payment_mode, reference } = req.body;
    if (!amount || !payment_date) return res.status(400).json({ error: 'Amount and payment_date required' });

    const invRes = await client.query('SELECT * FROM invoices WHERE id = $1 AND business_id = $2', [req.params.id, req.business.id]);
    if (!invRes.rows.length) return res.status(404).json({ error: 'Invoice not found' });

    const inv = invRes.rows[0];
    const newPaid = parseFloat(inv.paid_amount) + parseFloat(amount);
    const newStatus = newPaid >= parseFloat(inv.total_amount) ? 'paid' : 'partial';

    await client.query(
      `UPDATE invoices SET paid_amount = $1, status = $2, updated_at = NOW() WHERE id = $3`,
      [newPaid, newStatus, inv.id]
    );

    // Record payment
    await client.query(
      `INSERT INTO payments (business_id, invoice_id, party_id, payment_date, amount, payment_mode, reference, payment_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'received')`,
      [req.business.id, inv.id, inv.party_id, payment_date, amount, payment_mode || 'cash', reference]
    );

    // Khata entry for payment received
    if (inv.party_id) {
      await client.query(
        `INSERT INTO khata_entries (business_id, party_id, entry_date, entry_type, amount, description, reference_type, reference_id)
         VALUES ($1,$2,$3,'debit',$4,$5,'payment',$6)`,
        [req.business.id, inv.party_id, payment_date, amount, `Payment received — ${inv.invoice_number}`, inv.id]
      );
    }

    await client.query('COMMIT');
    ok(res, { paid_amount: newPaid, status: newStatus });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /api/invoices/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await query(
      `UPDATE invoices SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND business_id = $2`,
      [req.params.id, req.business.id]
    );
    ok(res, { message: 'Invoice cancelled' });
  } catch (err) { next(err); }
});

module.exports = router;
