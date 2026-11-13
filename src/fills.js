/**
 * Turns an exchange order into the numbers the journal needs:
 * the real fill price, the amount actually held after fees, and the fee
 * expressed in the quote currency (USDT).
 */
export function summarizeFill(order, symbol) {
  const [base, quote] = symbol.split('/');
  const price = order.average ?? order.price ?? 0;
  const amount = order.filled ?? 0;
  const fees = order.fees?.length ? order.fees : order.fee ? [order.fee] : [];

  let feeBase = 0;
  let feeQuoteDirect = 0;
  let feeInOtherCurrency = false;
  for (const fee of fees) {
    const cost = Number(fee?.cost) || 0;
    if (!cost) continue;
    if (fee.currency === base) feeBase += cost;
    else if (fee.currency === quote) feeQuoteDirect += cost;
    else feeInOtherCurrency = true; // e.g. paid in BNB: not counted here
  }

  return {
    price,
    amount,
    // A buy fee charged in the base asset reduces what can be sold later.
    netAmount: amount - feeBase,
    cost: order.cost ?? amount * price,
    feeQuote: feeQuoteDirect + feeBase * price,
    feeInOtherCurrency,
  };
}
