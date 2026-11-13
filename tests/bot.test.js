/**
 * Offline tests: no exchange connection, and a throwaway journal file so the
 * real trades.json is never touched.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'trading-bot-test-'));
process.env.TRADES_PATH = join(dir, 'trades.json');

const { config, validateConfig, LIVE_CONFIRM_PHRASE } = await import('../src/config.js');
const { validateSetup, calculatePositionSize, canOpenTrade } = await import('../src/risk.js');
const journal = await import('../src/journal.js');
const { summarizeFill } = await import('../src/fills.js');
const { syncTrades } = await import('../src/sync.js');

beforeEach(() => {
  if (existsSync(config.tradesPath)) rmSync(config.tradesPath);
});

const longSetup = { symbol: 'BTC/USDT', direction: 'long', entry: 72000, stopLoss: 70500, takeProfit: 75500 };

function pendingTrade(overrides = {}) {
  return journal.recordEntry({
    symbol: 'BTC/USDT', direction: 'long', status: 'pending',
    entry: 72000, plannedEntry: 72000, stopLoss: 70500, takeProfit: 75500,
    amount: 0.01, amountUSDT: 720, orderId: 'E1', ...overrides,
  });
}

/** Fake exchange: orders by id, and a record of protective orders placed. */
function fakeApi(orders, { failProtection = false } = {}) {
  const placed = [];
  return {
    placed,
    fetchOrder: async (id) => {
      if (!orders[id]) throw new Error(`unknown order ${id}`);
      return orders[id];
    },
    placeProtection: async (symbol, amount, takeProfit, stopLoss) => {
      if (failProtection) throw new Error('price outside OCO range');
      placed.push({ symbol, amount, takeProfit, stopLoss });
      return { orderListId: 'L1', tpOrderId: 'TP1', slOrderId: 'SL1' };
    },
  };
}

// --- risk rules -------------------------------------------------------------

test('a valid long setup passes', () => {
  assert.deepEqual(validateSetup(longSetup), { valid: true, errors: [] });
});

test('short setups are rejected on spot', () => {
  const result = validateSetup({ ...longSetup, direction: 'short', stopLoss: 73500, takeProfit: 68500 });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /not supported/);
});

test('a setup without direction is rejected', () => {
  const { direction, ...noDirection } = longSetup;
  assert.equal(validateSetup(noDirection).valid, false);
});

test('reward:risk below 1.5 is rejected', () => {
  const result = validateSetup({ ...longSetup, takeProfit: 73000 });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /Risk:Reward/);
});

test('a long with the stop above the entry is rejected', () => {
  assert.equal(validateSetup({ ...longSetup, stopLoss: 72500 }).valid, false);
});

test('position size risks exactly the configured share of capital', () => {
  const sizing = calculatePositionSize(72000, 70500, 1000);
  const expectedRisk = 1000 * config.maxRiskPerTrade;
  assert.equal(sizing.riskAmount, expectedRisk);
  // Losing the full stop distance on the position equals the risk amount.
  assert.ok(Math.abs(sizing.positionUnits * 1500 - expectedRisk) < 0.01);
});

test('pending entries count toward the position limit', () => {
  for (let i = 0; i < config.maxOpenPositions; i++) pendingTrade({ orderId: `E${i}` });
  assert.equal(canOpenTrade().allowed, false);
});

// --- live-mode lock ---------------------------------------------------------

test('live mode stays locked without the confirmation phrase', () => {
  const saved = { mode: config.mode, liveConfirm: config.liveConfirm };
  try {
    config.mode = 'live';
    config.liveConfirm = '';
    assert.match(validateConfig().join(' '), /Live mode is locked/);
    config.liveConfirm = LIVE_CONFIRM_PHRASE;
    assert.doesNotMatch(validateConfig().join(' '), /Live mode is locked/);
  } finally {
    Object.assign(config, saved);
  }
});

// --- fills ------------------------------------------------------------------

test('a buy fee charged in BTC reduces the sellable amount', () => {
  const fill = summarizeFill(
    { average: 70000, filled: 0.01, cost: 700, fees: [{ cost: 0.00001, currency: 'BTC' }] },
    'BTC/USDT',
  );
  assert.equal(fill.price, 70000);
  assert.ok(Math.abs(fill.netAmount - 0.00999) < 1e-12);
  assert.ok(Math.abs(fill.feeQuote - 0.7) < 1e-9);
});

test('a fill uses the average price, not the order price', () => {
  const fill = summarizeFill({ price: 72000, average: 71950, filled: 0.01 }, 'BTC/USDT');
  assert.equal(fill.price, 71950);
  assert.equal(fill.cost, 719.5);
});

// --- journal ----------------------------------------------------------------

test('exit P&L subtracts entry and exit fees', () => {
  const trade = journal.recordEntry({
    symbol: 'BTC/USDT', direction: 'long', entry: 70000, stopLoss: 68000, takeProfit: 74000,
    amount: 0.01, amountUSDT: 700, fees: 0.7,
  });
  const closed = journal.recordExit(trade.id, 74000, 0.74, 'take_profit');
  assert.ok(Math.abs(closed.pnl - (40 - 0.7 - 0.74)) < 1e-9);
  assert.equal(closed.exitReason, 'take_profit');
  assert.equal(closed.status, 'closed');
});

// --- sync with the exchange --------------------------------------------------

test('an unfilled limit entry stays pending and is not a position', async () => {
  pendingTrade();
  const api = fakeApi({ E1: { status: 'open', filled: 0 } });
  assert.deepEqual(await syncTrades(api), []);
  assert.equal(journal.getOpenPositions().length, 0);
  assert.equal(journal.getPendingEntries().length, 1);
  assert.equal(api.placed.length, 0);
});

test('a filled entry becomes open at the real price and gets protection', async () => {
  const trade = pendingTrade();
  const api = fakeApi({ E1: { status: 'closed', average: 71990, filled: 0.01, cost: 719.9 } });
  const events = await syncTrades(api);

  assert.deepEqual(events.map(e => e.type), ['filled', 'protected']);
  const [open] = journal.getOpenPositions();
  assert.equal(open.id, trade.id);
  assert.equal(open.entry, 71990);
  assert.equal(open.plannedEntry, 72000);
  assert.deepEqual(open.protection, { orderListId: 'L1', tpOrderId: 'TP1', slOrderId: 'SL1' });
  assert.deepEqual(api.placed, [{ symbol: 'BTC/USDT', amount: 0.01, takeProfit: 75500, stopLoss: 70500 }]);
});

test('a failed protection is reported, never hidden', async () => {
  pendingTrade();
  const api = fakeApi({ E1: { status: 'closed', average: 72000, filled: 0.01 } }, { failProtection: true });
  const events = await syncTrades(api);
  assert.deepEqual(events.map(e => e.type), ['filled', 'unprotected']);
  assert.equal(journal.getOpenPositions()[0].protection, null);
});

test('a cancelled entry that never filled is marked cancelled', async () => {
  pendingTrade();
  await syncTrades(fakeApi({ E1: { status: 'canceled', filled: 0 } }));
  assert.equal(journal.loadTrades()[0].status, 'cancelled');
  assert.equal(journal.getOpenPositions().length, 0);
});

test('a stop loss filled on the exchange closes the trade with a loss', async () => {
  pendingTrade();
  const orders = {
    E1: { status: 'closed', average: 72000, filled: 0.01, cost: 720 },
    TP1: { status: 'open', filled: 0 },
    SL1: { status: 'open', filled: 0 },
  };
  const api = fakeApi(orders);
  await syncTrades(api);

  orders.SL1 = { status: 'closed', average: 70480, filled: 0.01, fees: [{ cost: 0.7, currency: 'USDT' }] };
  orders.TP1 = { status: 'expired', filled: 0 };
  const events = await syncTrades(api);

  assert.equal(events[0].type, 'closed');
  assert.equal(events[0].reason, 'stop_loss');
  const [closed] = journal.loadTrades();
  assert.equal(closed.status, 'closed');
  assert.equal(closed.exitPrice, 70480);
  assert.ok(Math.abs(closed.pnl - ((70480 - 72000) * 0.01 - 0.7)) < 1e-9);
});

test('protective orders cancelled by hand leave the trade flagged unprotected', async () => {
  const trade = journal.recordEntry({
    symbol: 'BTC/USDT', direction: 'long', entry: 72000, stopLoss: 70500, takeProfit: 75500,
    amount: 0.01, amountUSDT: 720, protection: { orderListId: 'L1', tpOrderId: 'TP1', slOrderId: 'SL1' },
  });
  const events = await syncTrades(fakeApi({ TP1: { status: 'canceled' }, SL1: { status: 'canceled' } }));
  assert.equal(events[0].type, 'unprotected');
  assert.equal(journal.loadTrades().find(t => t.id === trade.id).protection, null);
});
