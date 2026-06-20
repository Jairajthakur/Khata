const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { ok, created } = require('../middleware/errorHandler');
const { parseCommand, formatResponse } = require('../utils/whatsappParser');
const { computeItemTax, round2 } = require('../utils/gstCalculator');

router.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

router.post('/webhook', async (req, res, next) => {
  try {
    const { from, to, text } = extractMessage(req.body);
    if (!from || !text) return res.sendStatus(200);

    const bizRes = await query('SELECT * FROM businesses WHERE whatsapp_number = $1 LIMIT 1', [from]);
    const business = bizRes.rows[0];

    const intentObj = parseCommand(text);
    let responseData = {};
    let responseText;

    if (!business) {
      responseText = `⚠ This number isn't linked to a KhataBill account yet. Please register at the app first.`;
    } else {
      responseData = await handleIntent(business, intentObj);
      responseText = formatResponse(intentObj.intent, responseData);
    }

    await query(
      `INSERT INTO whatsapp_messages (business_id, from_number, to_number, direction, command, response, status)
       VALUES ($1,$2,$3,'inbound',$4,$5,'received')`,
      [business ? business.id : null, from, to || null, text, responseText]
    );

    res.status(200).json({ success: true, intent: intentObj.intent, reply: responseText });
  } catch (err) { next(err); }
});

router.post('/simulate', async (req, res, next) => {
  try {
    const { business_id, message } = req.body;
    if (!business_id || !message) return res.status(400).json({ error: 'business_id and message are required' });

    const bizRes = await query('SELECT * FROM businesses WHERE id = $1', [business_id]);
    if (!bizRes.rows.length) return res.status(404).json({ error: 'Business not found' });

    const intentObj = parseCommand(message);
    const responseData = await handleIntent(bizRes.rows[0], intentObj);
    const responseText = formatResponse(intentObj.intent, responseData);

    created(res, { intent: intentObj.intent, data: responseData, reply: responseText });
  } catch (err) { next(err); }
});

async function handleIntent(business, intentObj) {
  switch (intentObj.intent) {
    case 'CREATE_INVOICE': {
      const { partyName, amount, gstRate } = intentObj;
      if (!partyName || !amount) return { partyName, total: 0, gstRate };

      const partyRes = await query(
        `SELECT id FROM parties WHERE business_id = $1 AND name ILIKE $2 LIMIT 1`,
        [business.id, partyName]
      );
      const partyId = partyRes.rows[0] ? partyRes.rows[0].id : null;
      const tax = computeItemTax(amount, 1, 0, gstRate, false);
      const invNum = `WA-${Date.now()}`;

      await query(
        `INSERT INTO invoices
           (business_id, party_id, invoice_number, invoice_type, invoice_date,
            subtotal, taxable_amount, cgst_amount, sgst_amount, total_tax, total_amount, status)
         VALUES ($1,$2,$3,'sale',CURRENT_DATE,$4,$5,$6,$7,$8,$9,'unpaid')`,
        [business.id, partyId, invNum, tax.subtotal, tax.taxable_amount,
          tax.cgst_amount, tax.sgst_amount, tax.cgst_amount + tax.sgst_amount, tax.total_amount]
      );
      return { invoiceNumber: invNum, partyName, total: tax.total_amount, gstRate };
    }

    case 'RECORD_PAYMENT': {
      const { partyName, amount } = intentObj;
      const partyRes = await query(
        `SELECT id FROM parties WHERE business_id = $1 AND name ILIKE $2 LIMIT 1`,
        [business.id, partyName]
      );
      const party = partyRes.rows[0];
      if (!party || !amount) return { partyName, amount: amount || 0, balance: 0 };

      await query(
        `INSERT INTO payments (business_id, party_id, payment_date, amount, payment_type)
         VALUES ($1,$2,CURRENT_DATE,$3,'received')`,
        [business.id, party.id, amount]
      );

      const balRes = await query(
        `SELECT
           COALESCE(SUM(CASE WHEN entry_type='credit' THEN amount ELSE -amount END), 0) as balance
         FROM khata_entries WHERE business_id = $1 AND party_id = $2`,
        [business.id, party.id]
      );
      return { partyName, amount, balance: round2(parseFloat(balRes.rows[0].balance)) };
    }

    case 'ADD_EXPENSE': {
      const { amount, category } = intentObj;
      if (!amount) return { category, amount: 0, itcEligible: false };
      await query(
        `INSERT INTO expenses (business_id, expense_date, category, amount, total_amount, itc_eligible)
         VALUES ($1, CURRENT_DATE, $2, $3, $3, false)`,
        [business.id, category, amount]
      );
      return { category, amount, itcEligible: false };
    }

    case 'GET_REPORT': {
      const salesRes = await query(
        `SELECT COALESCE(SUM(total_amount),0) as t FROM invoices
           WHERE business_id = $1 AND invoice_type='sale' AND invoice_date = CURRENT_DATE`,
        [business.id]
      );
      const expRes = await query(
        `SELECT COALESCE(SUM(total_amount),0) as t FROM expenses
           WHERE business_id = $1 AND expense_date = CURRENT_DATE`,
        [business.id]
      );
      const pendingRes = await query(
        `SELECT COALESCE(SUM(total_amount - paid_amount),0) as t FROM invoices
           WHERE business_id = $1 AND status IN ('unpaid','partial','overdue')`,
        [business.id]
      );
      return {
        sales: round2(parseFloat(salesRes.rows[0].t)),
        expenses: round2(parseFloat(expRes.rows[0].t)),
        cash: round2(parseFloat(salesRes.rows[0].t) - parseFloat(expRes.rows[0].t)),
        pending: round2(parseFloat(pendingRes.rows[0].t)),
      };
    }

    case 'GST_DUE': {
      const now = new Date();
      const period = `${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`;
      const retRes = await query(
        `SELECT * FROM gst_returns WHERE business_id = $1 AND return_type='GSTR-3B' AND period = $2`,
        [business.id, period]
      );
      const ret = retRes.rows[0];
      return {
        netPayable: ret ? round2(ret.net_payable) : 0,
        dueDate: ret ? ret.due_date : null,
        outputGst: ret ? round2(ret.output_igst + ret.output_cgst + ret.output_sgst) : 0,
        itc: ret ? round2(ret.itc_igst + ret.itc_cgst + ret.itc_sgst) : 0,
      };
    }

    case 'OUTSTANDING': {
      const toReceiveRes = await query(
        `SELECT COALESCE(SUM(total_amount - paid_amount),0) as t FROM invoices
           WHERE business_id = $1 AND invoice_type='sale' AND status IN ('unpaid','partial','overdue')`,
        [business.id]
      );
      const toPayRes = await query(
        `SELECT COALESCE(SUM(total_amount - paid_amount),0) as t FROM invoices
           WHERE business_id = $1 AND invoice_type='purchase' AND status IN ('unpaid','partial','overdue')`,
        [business.id]
      );
      const toReceive = round2(parseFloat(toReceiveRes.rows[0].t));
      const toPay = round2(parseFloat(toPayRes.rows[0].t));
      return { toReceive, toPay, net: round2(toReceive - toPay) };
    }

    case 'SEND_REMINDER':
      return { partyName: intentObj.partyName };

    case 'ADD_STOCK':
      return { qty: intentObj.qty, item: intentObj.item };

    default:
      return {};
  }
}

function extractMessage(body) {
  try {
    const entry = body.entry && body.entry[0];
    const change = entry && entry.changes && entry.changes[0];
    const value = change && change.value;
    const message = value && value.messages && value.messages[0];
    if (!message) return { from: null, to: null, text: null };
    return {
      from: message.from,
      to: value.metadata ? value.metadata.display_phone_number : null,
      text: message.text ? message.text.body : null,
    };
  } catch {
    return { from: null, to: null, text: null };
  }
}

module.exports = router;
