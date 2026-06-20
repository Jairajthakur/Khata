/**
 * Compute GST breakdown for an invoice item
 * @param {number} rate - Unit price
 * @param {number} qty - Quantity
 * @param {number} discountPct - Discount percentage
 * @param {number} gstRate - GST rate (5, 12, 18, 28)
 * @param {boolean} isIgst - Inter-state (IGST) or intra-state (CGST+SGST)
 */
const computeItemTax = (rate, qty = 1, discountPct = 0, gstRate = 18, isIgst = false) => {
  const subtotal = rate * qty;
  const discount = (subtotal * discountPct) / 100;
  const taxable = subtotal - discount;
  const totalGst = (taxable * gstRate) / 100;

  return {
    subtotal: round2(subtotal),
    discount: round2(discount),
    taxable_amount: round2(taxable),
    gst_rate: gstRate,
    igst_amount: isIgst ? round2(totalGst) : 0,
    cgst_amount: isIgst ? 0 : round2(totalGst / 2),
    sgst_amount: isIgst ? 0 : round2(totalGst / 2),
    total_amount: round2(taxable + totalGst),
  };
};

/**
 * Roll up all items into invoice totals
 */
const computeInvoiceTotals = (items, isIgst = false) => {
  return items.reduce((acc, item) => {
    acc.subtotal        += item.subtotal        || 0;
    acc.discount_amount += item.discount        || 0;
    acc.taxable_amount  += item.taxable_amount  || 0;
    acc.igst_amount     += item.igst_amount     || 0;
    acc.cgst_amount     += item.cgst_amount     || 0;
    acc.sgst_amount     += item.sgst_amount     || 0;
    acc.total_tax       += (item.igst_amount + item.cgst_amount + item.sgst_amount) || 0;
    acc.total_amount    += item.total_amount    || 0;
    return acc;
  }, {
    subtotal: 0, discount_amount: 0, taxable_amount: 0,
    igst_amount: 0, cgst_amount: 0, sgst_amount: 0,
    total_tax: 0, total_amount: 0,
    is_igst: isIgst,
  });
};

/**
 * Determine if a transaction is inter-state (IGST) based on state codes
 */
const isInterState = (businessStateCode, partyStateCode) => {
  if (!partyStateCode) return false;
  return businessStateCode !== partyStateCode;
};

/**
 * Compute GSTR-3B summary from invoices + expenses for a given period
 */
const computeGSTR3B = (salesInvoices, purchaseExpenses) => {
  const output = { igst: 0, cgst: 0, sgst: 0, taxable: 0 };
  const itc    = { igst: 0, cgst: 0, sgst: 0 };

  salesInvoices.forEach(inv => {
    output.taxable += parseFloat(inv.taxable_amount || 0);
    output.igst    += parseFloat(inv.igst_amount    || 0);
    output.cgst    += parseFloat(inv.cgst_amount    || 0);
    output.sgst    += parseFloat(inv.sgst_amount    || 0);
  });

  purchaseExpenses.forEach(exp => {
    if (exp.itc_eligible) {
      itc.igst += parseFloat(exp.igst_amount || 0);
      itc.cgst += parseFloat(exp.cgst_amount || 0);
      itc.sgst += parseFloat(exp.sgst_amount || 0);
    }
  });

  return {
    output_igst:   round2(output.igst),
    output_cgst:   round2(output.cgst),
    output_sgst:   round2(output.sgst),
    taxable_amount: round2(output.taxable),
    itc_igst:      round2(itc.igst),
    itc_cgst:      round2(itc.cgst),
    itc_sgst:      round2(itc.sgst),
    net_igst:      round2(output.igst - itc.igst),
    net_cgst:      round2(output.cgst - itc.cgst),
    net_sgst:      round2(output.sgst - itc.sgst),
    net_payable:   round2((output.igst - itc.igst) + (output.cgst - itc.cgst) + (output.sgst - itc.sgst)),
  };
};

/**
 * GST return due dates
 */
const getDueDate = (returnType, period) => {
  // period format: "06-2025" = MMYYYY
  const [month, year] = period.split('-').map(Number);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear  = month === 12 ? year + 1 : year;

  const dueDays = { 'GSTR-1': 11, 'GSTR-3B': 20 };
  const day = dueDays[returnType] || 31;
  return new Date(nextYear, nextMonth - 1, day).toISOString().split('T')[0];
};

const round2 = (n) => Math.round(n * 100) / 100;

module.exports = { computeItemTax, computeInvoiceTotals, isInterState, computeGSTR3B, getDueDate, round2 };
