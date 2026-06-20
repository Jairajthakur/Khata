const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, requireBusiness } = require('../middleware/auth');
const { ok, created } = require('../middleware/errorHandler');

router.use(authenticate, requireBusiness);

// GET /api/khata?limit=30&party_id=xxx
router.get('/', async (req, res, next) => {
  try {
    const { limit = 30, party_id } = req.query;
    let sql = `
      SELECT k.*, p.name as party_name
      FROM khata_entries k
      LEFT JOIN parties p ON p.id = k.party_id
      WHERE k.business_id = $1
    `;
    const vals = [req.business.id];
    let i = 2;
    if (party_id) { sql += ` AND k.party_id = $${i++}`; vals.push(party_id); }
    sql += ` ORDER BY k.entry_date DESC, k.created_at DESC LIMIT $${i}`;
    vals.push(parseInt(limit));

    const result = await query(sql, vals);
    ok(res, result.rows);
  } catch (err) { next(err); }
});

// POST /api/khata  — add a manual cash book entry
router.post('/', async (req, res, next) => {
  try {
    const { entry_date, entry_type, amount, description, party_name } = req.body;
    if (!entry_date || !entry_type || !amount) {
      return res.status(400).json({ error: 'entry_date, entry_type and amount are required' });
    }
    if (!['credit', 'debit'].includes(entry_type)) {
      return res.status(400).json({ error: 'entry_type must be credit or debit' });
    }

    // Resolve party by name if provided
    let party_id = null;
    if (party_name) {
      const partyRes = await query(
        `SELECT id FROM parties WHERE business_id = $1 AND name ILIKE $2 LIMIT 1`,
        [req.business.id, party_name]
      );
      if (partyRes.rows.length) party_id = partyRes.rows[0].id;
    }

    const result = await query(
      `INSERT INTO khata_entries (business_id, party_id, entry_date, entry_type, amount, description)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.business.id, party_id, entry_date, entry_type, parseFloat(amount), description || null]
    );

    created(res, result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/khata/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await query(
      `DELETE FROM khata_entries WHERE id = $1 AND business_id = $2`,
      [req.params.id, req.business.id]
    );
    ok(res, { message: 'Entry deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
