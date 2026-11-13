/**
 * Reconciles the journal with what actually happened on the exchange.
 *
 * - A pending limit entry becomes an open position only once it fills,
 *   using the real fill price, and gets its protective orders at that moment.
 * - An open position is closed in the journal when its take profit or stop
 *   loss order fills on the exchange.
 *
 * The exchange functions are injected so this logic can be tested offline.
 */
import { loadTrades, updateTrade, recordExit } from './journal.js';
import { summarizeFill } from './fills.js';

const DEAD = ['canceled', 'cancelled', 'expired', 'rejected'];

export async function syncTrades(api) {
  const events = [];
  for (const trade of loadTrades()) {
    try {
      if (trade.status === 'pending') {
        events.push(...await syncPending(trade, api));
      } else if (trade.status === 'open' && trade.protection) {
        events.push(...await syncProtected(trade, api));
      }
    } catch (err) {
      events.push({ id: trade.id, type: 'error', message: err.message });
    }
  }
  return events;
}

/**
 * Places the take profit + stop loss pair for an open trade and stores it.
 */
export async function protectTrade(trade, api) {
  const protection = await api.placeProtection(
    trade.symbol, trade.amount, trade.takeProfit, trade.stopLoss,
  );
  updateTrade(trade.id, { protection });
  return protection;
}

async function syncPending(trade, api) {
  const order = await api.fetchOrder(trade.entryOrderId, trade.symbol);
  const fill = summarizeFill(order, trade.symbol);
  const dead = DEAD.includes(order.status);

  if (order.status === 'closed' || (dead && fill.amount > 0)) {
    const opened = updateTrade(trade.id, {
      status: 'open',
      entry: fill.price,
      amount: fill.netAmount,
      amountUSDT: fill.cost,
      fees: fill.feeQuote,
      openedAt: new Date().toISOString(),
    });
    const events = [{ id: trade.id, type: 'filled', price: fill.price, amount: fill.netAmount }];
    try {
      const protection = await protectTrade(opened, api);
      events.push({ id: trade.id, type: 'protected', orderListId: protection.orderListId });
    } catch (err) {
      events.push({ id: trade.id, type: 'unprotected', message: err.message });
    }
    return events;
  }

  if (dead) {
    updateTrade(trade.id, { status: 'cancelled', closedAt: new Date().toISOString() });
    return [{ id: trade.id, type: 'cancelled' }];
  }

  return [];
}

async function syncProtected(trade, api) {
  const { tpOrderId, slOrderId } = trade.protection;
  const tp = await api.fetchOrder(tpOrderId, trade.symbol);
  const sl = await api.fetchOrder(slOrderId, trade.symbol);

  for (const [order, reason] of [[tp, 'take_profit'], [sl, 'stop_loss']]) {
    if (order.status === 'closed') {
      const fill = summarizeFill(order, trade.symbol);
      const closed = recordExit(trade.id, fill.price, fill.feeQuote, reason);
      return [{ id: trade.id, type: 'closed', reason, price: fill.price, pnl: closed.pnl }];
    }
  }

  if (DEAD.includes(tp.status) && DEAD.includes(sl.status)) {
    updateTrade(trade.id, { protection: null });
    return [{ id: trade.id, type: 'unprotected', message: 'Protective orders were cancelled on the exchange' }];
  }

  return [];
}
