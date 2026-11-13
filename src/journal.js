/**
 * Trading journal — records every trade for analysis.
 * Stores in trades.json for persistence.
 *
 * Trade statuses:
 *   pending   — limit entry order placed, not filled yet (not a position)
 *   open      — entry filled; the position exists on the exchange
 *   closed    — position exited (take profit, stop loss or manual)
 *   cancelled — entry order never filled and was cancelled
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { config } from './config.js';

/**
 * Load all trades from journal.
 */
export function loadTrades() {
  if (!existsSync(config.tradesPath)) return [];
  try {
    return JSON.parse(readFileSync(config.tradesPath, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * Save trades to journal.
 */
function saveTrades(trades) {
  writeFileSync(config.tradesPath, JSON.stringify(trades, null, 2));
}

/**
 * Record a new trade. Pass status 'pending' for an unfilled limit entry.
 */
export function recordEntry(trade) {
  const trades = loadTrades();
  const entry = {
    id: `T${Date.now()}`,
    symbol: trade.symbol,
    direction: trade.direction,
    plannedEntry: trade.plannedEntry ?? trade.entry,
    entry: trade.entry,
    stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit,
    amount: trade.amount,
    amountUSDT: trade.amountUSDT,
    orderId: trade.orderId || null,
    entryOrderId: trade.orderId || null,
    protection: trade.protection || null,
    status: trade.status || 'open',
    reason: trade.reason || '',
    openedAt: new Date().toISOString(),
    closedAt: null,
    exitPrice: null,
    exitReason: null,
    pnl: null,
    pnlPercent: null,
    fees: trade.fees || 0,
  };
  trades.push(entry);
  saveTrades(trades);
  return entry;
}

/**
 * Merge changes into an existing trade.
 */
export function updateTrade(tradeId, patch) {
  const trades = loadTrades();
  const trade = trades.find(t => t.id === tradeId);
  if (!trade) throw new Error(`Trade ${tradeId} not found`);
  Object.assign(trade, patch);
  saveTrades(trades);
  return trade;
}

/**
 * Record trade exit.
 * @param {string} exitReason - 'take_profit' | 'stop_loss' | 'manual'
 */
export function recordExit(tradeId, exitPrice, fees = 0, exitReason = 'manual') {
  const trades = loadTrades();
  const trade = trades.find(t => t.id === tradeId);
  if (!trade) throw new Error(`Trade ${tradeId} not found`);

  trade.status = 'closed';
  trade.closedAt = new Date().toISOString();
  trade.exitPrice = exitPrice;
  trade.exitReason = exitReason;
  trade.protection = null;
  trade.fees = (trade.fees || 0) + fees;

  if (trade.direction === 'long') {
    trade.pnl = (exitPrice - trade.entry) * trade.amount - trade.fees;
  } else {
    trade.pnl = (trade.entry - exitPrice) * trade.amount - trade.fees;
  }
  trade.pnlPercent = (trade.pnl / trade.amountUSDT) * 100;

  saveTrades(trades);
  return trade;
}

/**
 * Get open positions (entry filled, not exited).
 */
export function getOpenPositions() {
  return loadTrades().filter(t => t.status === 'open');
}

/**
 * Get limit entries that have not filled yet.
 */
export function getPendingEntries() {
  return loadTrades().filter(t => t.status === 'pending');
}

/**
 * Get trade statistics.
 */
export function getStats() {
  const trades = loadTrades();
  const closed = trades.filter(t => t.status === 'closed');
  if (closed.length === 0) return { trades: 0, message: 'No closed trades yet' };

  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const totalPnL = closed.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;

  return {
    totalTrades: closed.length,
    openPositions: trades.filter(t => t.status === 'open').length,
    wins: wins.length,
    losses: losses.length,
    winRate: Math.round((wins.length / closed.length) * 100),
    totalPnL: Math.round(totalPnL * 100) / 100,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    profitFactor: avgLoss !== 0 ? Math.round((avgWin / Math.abs(avgLoss)) * 100) / 100 : Infinity,
    bestTrade: Math.round(Math.max(...closed.map(t => t.pnl)) * 100) / 100,
    worstTrade: Math.round(Math.min(...closed.map(t => t.pnl)) * 100) / 100,
  };
}
