const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await query('SELECT id, email, name FROM users WHERE id = $1 AND is_active = true', [decoded.userId]);
    if (!result.rows.length) return res.status(401).json({ error: 'User not found' });
    req.user = result.rows[0];

    // Attach business
    const biz = await query('SELECT * FROM businesses WHERE user_id = $1 LIMIT 1', [req.user.id]);
    req.business = biz.rows[0] || null;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

const requireBusiness = (req, res, next) => {
  if (!req.business) return res.status(400).json({ error: 'No business profile found. Please complete setup.' });
  next();
};

module.exports = { authenticate, requireBusiness };
