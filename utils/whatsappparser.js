/**
 * Parse WhatsApp commands into structured intents
 * Supports: BILL, PAID, KHARCHA, REPORT, GST DUE, BAKAYA, REMIND, STOCK
 */
const parseCommand = (rawText) => {
  const text = rawText.trim().toUpperCase();
  const parts = rawText.trim().split(/\s+/);
  const cmd = parts[0].toUpperCase();

  switch (cmd) {
    case 'BILL': {
      // BILL <party_name> <amount> [GST<rate>]
      const partyName = parts[1] || null;
      const amount = parseFloat(parts[2]) || null;
      const gstMatch = parts.find(p => p.toUpperCase().startsWith('GST'));
      const gstRate = gstMatch ? parseFloat(gstMatch.replace(/GST/i, '')) : 18;
      return { intent: 'CREATE_INVOICE', partyName, amount, gstRate, raw: rawText };
    }

    case 'PAID': {
      // PAID <party_name> <amount>
      return { intent: 'RECORD_PAYMENT', partyName: parts[1], amount: parseFloat(parts[2]) || null, raw: rawText };
    }

    case 'KHARCHA': {
      // KHARCHA <amount> <category>
      const amount = parseFloat(parts[1]) || null;
      const category = parts.slice(2).join(' ') || 'Other';
      return { intent: 'ADD_EXPENSE', amount, category, raw: rawText };
    }

    case 'REPORT':
      return { intent: 'GET_REPORT', period: 'today', raw: rawText };

    case 'GST':
      if (parts[1] && parts[1].toUpperCase() === 'DUE') {
        return { intent: 'GST_DUE', raw: rawText };
      }
      break;

    case 'BAKAYA':
      return { intent: 'OUTSTANDING', raw: rawText };

    case 'REMIND':
      return { intent: 'SEND_REMINDER', partyName: parts[1], raw: rawText };

    case 'STOCK': {
      // STOCK <qty> <item_name>
      const qty = parseFloat(parts[1]) || 1;
      const item = parts.slice(2).join(' ');
      return { intent: 'ADD_STOCK', qty, item, raw: rawText };
    }

    default:
      return { intent: 'UNKNOWN', raw: rawText };
  }
};

/**
 * Format a WhatsApp response message
 */
const formatResponse = (intent, data = {}) => {
  switch (intent) {
    case 'CREATE_INVOICE':
      return `✅ *Invoice Created!*\nNo: ${data.invoiceNumber}\nParty: ${data.partyName}\nAmount: ₹${data.total} (incl. ${data.gstRate}% GST)\n\nReply *SEND* to share with customer.`;

    case 'RECORD_PAYMENT':
      return `✅ *Payment Recorded!*\nFrom: ${data.partyName}\nAmount: ₹${data.amount}\nUpdated balance: ₹${data.balance}`;

    case 'ADD_EXPENSE':
      return `✅ *Expense Added!*\nCategory: ${data.category}\nAmount: ₹${data.amount}\nITC Eligible: ${data.itcEligible ? 'Yes ✓' : 'No'}`;

    case 'GET_REPORT':
      return `📊 *Today's Summary*\nSales: ₹${data.sales}\nExpenses: ₹${data.expenses}\nCash Balance: ₹${data.cash}\nPending: ₹${data.pending}`;

    case 'GST_DUE':
      return `🏦 *GST Due*\nGSTR-3B: ₹${data.netPayable} due by ${data.dueDate}\nOutput GST: ₹${data.outputGst}\nITC Credit: ₹${data.itc}`;

    case 'OUTSTANDING':
      return `💰 *Outstanding (Bakaya)*\nTo Receive: ₹${data.toReceive}\nTo Pay: ₹${data.toPay}\nNet: ₹${data.net >= 0 ? '+' : ''}${data.net}`;

    case 'SEND_REMINDER':
      return `📤 *Reminder Sent!*\nPayment reminder sent to ${data.partyName} on WhatsApp.`;

    case 'UNKNOWN':
    default:
      return `⚠ Command not recognized.\n\nTry:\n• BILL <party> <amount>\n• PAID <party> <amount>\n• KHARCHA <amount> <category>\n• REPORT\n• GST DUE\n• BAKAYA\n• REMIND <party>`;
  }
};

module.exports = { parseCommand, formatResponse };
