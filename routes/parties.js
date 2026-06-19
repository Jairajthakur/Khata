const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, requireBusiness } = require('../middleware/auth');
const { ok, created } = require('../middleware/errorHandler');

// All routes require auth
router.use(authenticate, requireBusiness);

// GET /api/parties — list all parties with balance
router.get('/', async (req, res, next) => {
  try {
    const { type, search } = req.query;
    let sql = `
      SELECT p.*,
        COALESCE(SUM(CASE WHEN k.entry_type='credit' THEN k.amount ELSE 0 END), 0) as total_credit,
        COALESCE(SUM(CASE WHEN k.entry_type='debit'  THEN k.amount ELSE 0 END), 0) as total_debit
      FROM parties p
      LEFT JOIN khata_entries k ON k.party_id = p.id
      WHERE p.business_id = $1 AND p.is_active = true
    `;
    const vals = [req.business.id];
    let i = 2;

    if (type) { sql += ` AND p.party_type = $${i++}`; vals.push(type); }
    if (search) { sql += ` AND p.name ILIKE $${i++}`; vals.push(`%${search}%`); }

    sql += ' GROUP BY p.id ORDER BY p.name';
    const result = await query(sql, vals);

    const parties = result.rows.map(p => ({
      ...p,
      net_balance: parseFloat(p.total_credit) - parseFloat(p.total_debit) + parseFloat(p.opening_balance || 0),
    }));

    ok(res, parties);
  } catch (err) { next(err); }
});

// GET /api/parties/summary — to receive vs to pay totals
router.get('/summary', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT
        SUM(CASE WHEN net > 0 THEN net ELSE 0 END) as to_receive,
        SUM(CASE WHEN net < 0 THEN ABS(net) ELSE 0 END) as to_pay
      FROM (
        SELECT p.id,
          p.opening_balance +
          COALESCE(SUM(CASE WHEN k.entry_type='credit' THEN k.amount ELSE -k.amount END), 0) as net
        FROM parties p
        LEFT JOIN khata_entries k ON k.party_id = p.id
        WHERE p.business_id = $1 AND p.is_active = true
        GROUP BY p.id, p.opening_balance
      ) balances
    `, [req.business.id]);

    ok(res, result.rows[0]);
  } catch (err) { next(err); }
});

// GET /api/parties/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM parties WHERE id = $1 AND business_id = $2', [req.params.id, req.business.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Party not found' });
    ok(res, result.rows[0]);
  } catch (err) { next(err); }
});

// GET /api/parties/:id/ledger — transaction history
router.get('/:id/ledger', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    let sql = `
      SELECT k.*, 
        i.invoice_number, i.total_amount as invoice_amount
      FROM khata_entries k
      LEFT JOIN invoices i ON i.id = k.reference_id AND k.reference_type = 'invoice'
      WHERE k.party_id = $1 AND k.business_id = $2
    `;
    const vals = [req.params.id, req.business.id];
    let i = 3;
    if (from) { sql += ` AND k.entry_date >= $${i++}`; vals.push(from); }
    if (to)   { sql += ` AND k.entry_date <= $${i++}`; vals.push(to); }
    sql += ' ORDER BY k.entry_date DESC, k.created_at DESC';

    const entries = await query(sql, vals);
    const party = await query('SELECT * FROM parties WHERE id = $1', [req.params.id]);

    ok(res, { party: party.rows[0], entries: entries.rows });
  } catch (err) { next(err); }
});

// POST /api/parties
router.post('/', async (req, res, next) => {
  try {
    const { name, mobile, gstin, pan, party_type, address, city, state_code, opening_balance, balance_type } = req.body;
    if (!name || !party_type) return res.status(400).json({ error: 'Name and party_type are required' });

    const result = await query(
      `INSERT INTO parties (business_id, name, mobile, gstin, pan, party_type, address, city, state_code, opening_balance, balance_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.business.id, name, mobile, gstin, pan, party_type, address, city, state_code, opening_balance || 0, balance_type || 'credit']
    );

    // Log to activity
    await query(`INSERT INTO activity_log (business_id, user_id, action, entity_type, entity_id, description)
      VALUES ($1,$2,'party_created','party',$3,$4)`,
      [req.business.id, req.user.id, result.rows[0].id, `Party '${name}' added`]);

    created(res, result.rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/parties/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const fields = ['name','mobile','gstin','pan','address','city','state_code','opening_balance','balance_type','is_active'];
    const updates = []; const vals = []; let i = 1;
    fields.forEach(f => { if (req.body[f] !== undefined) { updates.push(`${f} = $${i++}`); vals.push(req.body[f]); } });
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id); vals.push(req.business.id);
    const result = await query(
      `UPDATE parties SET ${updates.join(', ')}, updated_at=NOW() WHERE id = $${i++} AND business_id = $${i} RETURNING *`,
      vals
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Party not found' });
    ok(res, result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/parties/:id (soft delete)
router.delete('/:id', async (req, res, next) => {
  try {
    await query('UPDATE parties SET is_active = false WHERE id = $1 AND business_id = $2', [req.params.id, req.business.id]);
    ok(res, { message: 'Party deactivated' });
  } catch (err) { next(err); }
});

module.exports = router;
