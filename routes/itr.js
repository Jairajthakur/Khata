const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, requireBusiness } = require('../middleware/auth');
const { ok, created } = require('../middleware/errorHandler');
const { round2 } = require('../utils/gstCalculator');

router.use(authenticate, requireBusiness);

router.get('/', async (req, res, next) => {
  try {
    const result = await query(
      'SELECT * FROM itr_filings WHERE business_id = $1 ORDER BY financial_year DESC',
      [req.business.id]
    );
    ok(res, result.rows);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const result = await query(
      'SELECT * FROM itr_filings WHERE id = $1 AND business_id = $2',
      [req.params.id, req.business.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'ITR filing not found' });
    ok(res, result.rows[0]);
  } catch (err) { next(err); }
});

// POST /api/itr/estimate  body: { financial_year: 'YYYY-YY', deductions_80c }
router.post('/estimate', async (req, res, next) => {
  try {
    const { financial_year, deductions_80c = 0, presumptive_rate = 8 } = req.body;
    if (!financial_year) return res.status(400).json({ error: 'financial_year is required' });

    const [startYear] = financial_year.split('-');
    const fromDate = `${startYear}-04-01`;
    const toDate = `${Number(startYear) + 1}-03-31`;

    const turnoverRes = await query(
      `SELECT COALESCE(SUM(total_amount), 0) as turnover FROM invoices
         WHERE business_id = $1 AND invoice_type = 'sale'
         AND invoice_date BETWEEN $2 AND $3 AND status != 'cancelled'`,
      [req.business.id, fromDate, toDate]
    );

    const grossTurnover = parseFloat(turnoverRes.rows[0].turnover) || 0;
    const presumptiveIncome = round2(grossTurnover * (presumptive_rate / 100));
    const taxableIncome = round2(Math.max(presumptiveIncome - deductions_80c, 0));
    const taxPayable = round2(estimateTax(taxableIncome));

    ok(res, {
      financial_year,
      gross_turnover: round2(grossTurnover),
      presumptive_income: presumptiveIncome,
      deductions_80c: round2(deductions_80c),
      taxable_income: taxableIncome,
      tax_payable: taxPayable,
    });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const {
      financial_year, itr_form = 'ITR-4', gross_turnover = 0, presumptive_income = 0,
      deductions_80c = 0, taxable_income = 0, tax_payable = 0, tds_amount = 0,
    } = req.body;
    if (!financial_year) return res.status(400).json({ error: 'financial_year is required' });

    const refundAmount = round2(Math.max(tds_amount - tax_payable, 0));

    const result = await query(
      `INSERT INTO itr_filings
         (business_id, financial_year, itr_form, gross_turnover, presumptive_income,
          deductions_80c, taxable_income, tax_payable, tds_amount, refund_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (business_id, financial_year) DO UPDATE SET
         itr_form = EXCLUDED.itr_form, gross_turnover = EXCLUDED.gross_turnover,
         presumptive_income = EXCLUDED.presumptive_income, deductions_80c = EXCLUDED.deductions_80c,
         taxable_income = EXCLUDED.taxable_income, tax_payable = EXCLUDED.tax_payable,
         tds_amount = EXCLUDED.tds_amount, refund_amount = EXCLUDED.refund_amount, updated_at = NOW()
       RETURNING *`,
      [req.business.id, financial_year, itr_form, gross_turnover, presumptive_income,
        deductions_80c, taxable_income, tax_payable, tds_amount, refundAmount]
    );
    created(res, result.rows[0]);
  } catch (err) { next(err); }
});

router.patch('/:id/checklist', async (req, res, next) => {
  try {
    const { checklist } = req.body;
    if (!checklist || typeof checklist !== 'object') {
      return res.status(400).json({ error: 'checklist object is required' });
    }
    const result = await query(
      `UPDATE itr_filings SET checklist = $1, updated_at = NOW()
       WHERE id = $2 AND business_id = $3 RETURNING *`,
      [JSON.stringify(checklist), req.params.id, req.business.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'ITR filing not found' });
    ok(res, result.rows[0]);
  } catch (err) { next(err); }
});

router.patch('/:id/file', async (req, res, next) => {
  try {
    const { acknowledgement_no } = req.body;
    const result = await query(
      `UPDATE itr_filings SET status = 'filed', acknowledgement_no = $1, filed_on = NOW(), updated_at = NOW()
       WHERE id = $2 AND business_id = $3 RETURNING *`,
      [acknowledgement_no || null, req.params.id, req.business.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'ITR filing not found' });
    ok(res, result.rows[0]);
  } catch (err) { next(err); }
});

/**
 * Simplified new-regime slab estimate for individuals (FY 2024-25+).
 * Not a substitute for a CA / proper tax engine before actually filing.
 */
function estimateTax(taxableIncome) {
  const slabs = [
    { upto: 300000, rate: 0 },
    { upto: 700000, rate: 0.05 },
    { upto: 1000000, rate: 0.10 },
    { upto: 1200000, rate: 0.15 },
    { upto: 1500000, rate: 0.20 },
    { upto: Infinity, rate: 0.30 },
  ];
  let tax = 0;
  let lower = 0;
  for (const slab of slabs) {
    if (taxableIncome <= lower) break;
    const taxableInSlab = Math.min(taxableIncome, slab.upto) - lower;
    tax += taxableInSlab * slab.rate;
    lower = slab.upto;
  }
  if (taxableIncome <= 700000) return 0; // Section 87A rebate
  return tax + tax * 0.04; // + 4% Health & Education Cess
}

module.exports = router;
