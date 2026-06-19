const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { ok, created } = require('../middleware/errorHandler');

// POST /api/auth/register
router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password, mobile } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });

    const exists = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (exists.rows.length) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 12);
    const result = await query(
      `INSERT INTO users (name, email, password_hash, mobile) VALUES ($1, $2, $3, $4) RETURNING id, name, email, mobile, plan`,
      [name, email.toLowerCase(), hash, mobile || null]
    );

    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

    created(res, { user, token });
  } catch (err) { next(err); }
});

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const result = await query('SELECT * FROM users WHERE email = $1 AND is_active = true', [email.toLowerCase()]);
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

    const biz = await query('SELECT * FROM businesses WHERE user_id = $1 LIMIT 1', [user.id]);

    ok(res, {
      user: { id: user.id, name: user.name, email: user.email, plan: user.plan },
      business: biz.rows[0] || null,
      token,
    });
  } catch (err) { next(err); }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const biz = await query('SELECT * FROM businesses WHERE user_id = $1 LIMIT 1', [req.user.id]);
    ok(res, { user: req.user, business: biz.rows[0] || null });
  } catch (err) { next(err); }
});

// POST /api/auth/setup-business
router.post('/setup-business', authenticate, async (req, res, next) => {
  try {
    const { name, gstin, pan, business_type, gst_scheme, address, city, state_code, state_name, pincode } = req.body;
    if (!name) return res.status(400).json({ error: 'Business name required' });

    const existing = await query('SELECT id FROM businesses WHERE user_id = $1', [req.user.id]);
    if (existing.rows.length) return res.status(409).json({ error: 'Business already set up' });

    const result = await query(
      `INSERT INTO businesses (user_id, name, gstin, pan, business_type, gst_scheme, address, city, state_code, state_name, pincode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.user.id, name, gstin, pan, business_type || 'retail', gst_scheme || 'regular', address, city, state_code || '27', state_name || 'Maharashtra', pincode]
    );

    created(res, result.rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/auth/business
router.patch('/business', authenticate, async (req, res, next) => {
  try {
    if (!req.business) return res.status(404).json({ error: 'Business not found' });
    const fields = ['name','gstin','pan','business_type','gst_scheme','address','city','state_code','state_name','pincode'];
    const updates = [];
    const vals = [];
    let i = 1;

    fields.forEach(f => {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = $${i++}`);
        vals.push(req.body[f]);
      }
    });

    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    vals.push(req.business.id);

    const result = await query(
      `UPDATE businesses SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`,
      vals
    );
    ok(res, result.rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
