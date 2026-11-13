/**
 * Risk management module.
 * Enforces position sizing, max loss, and trade rules.
 */
import { config } from './config.js';
import { loadTrades } from './journal.js';

/**
 * Calculate position size based on risk per trade.
 * @param {number} entryPrice - planned entry price
 * @param {number} stopLoss - stop loss price
 * @param {number} capitalOverride - optional capital override
 * @returns {object} position sizing details
 */
export function calculatePositionSize(entryPrice, stopLoss, capitalOverride) {
  const capital = capitalOverride || config.tradingCapital;
  const riskAmount = capital * config.maxRiskPerTrade; // e.g., $1000 * 0.02 = $20
  const stopDistance = Math.abs(entryPrice - stopLoss);
  const stopPercent = stopDistance / entryPrice;

  // Position size = risk amount / stop distance per unit
  const positionSizeUnits = riskAmount / stopDistance;
  const positionSizeUSDT = positionSizeUnits * entryPrice;

  // Leverage check: if position size > capital, we'd need leverage
  const leverage = positionSizeUSDT / capital;

  return {
    capital,
    riskPercent: config.maxRiskPerTrade * 100,
    riskAmount: round(riskAmount),
    entryPrice,
    stopLoss,
    stopDistance: round(stopDistance),
    stopPercent: round(stopPercent * 100, 2),
    positionUnits: round(positionSizeUnits, 8),
    positionUSDT: round(positionSizeUSDT),
    leverage: round(leverage, 2),
    needsLeverage: leverage > 1,
    maxLoss: round(riskAmount),
    potentialFee: round(positionSizeUSDT * 0.001), // ~0.1% taker fee
  };
}

/**
 * Check if a new trade is allowed by risk rules.
 */
export function canOpenTrade() {
  const trades = loadTrades();
  const today = new Date().toISOString().split('T')[0];

  // Count open positions plus entries still waiting to fill: both commit capital
  const openPositions = trades.filter(t => t.status === 'open' || t.status === 'pending').length;
  if (openPositions >= config.maxOpenPositions) {
    return { allowed: false, reason: `Max open positions (${config.maxOpenPositions}) reached. Currently: ${openPositions}` };
  }

  // Check daily loss
  const todayTrades = trades.filter(t => t.closedAt && t.closedAt.startsWith(today));
  const todayPnL = todayTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const maxDailyLossAmount = config.tradingCapital * config.maxDailyLoss;

  if (todayPnL < -maxDailyLossAmount) {
    return { allowed: false, reason: `Daily loss limit reached. Today P&L: $${round(todayPnL)}. Max: -$${round(maxDailyLossAmount)}` };
  }

  return { allowed: true, openPositions, todayPnL: round(todayPnL) };
}

/**
 * Validate a trade setup before execution.
 */
export function validateSetup(setup) {
  const errors = [];

  if (!setup.symbol) errors.push('Symbol required');
  if (!setup.entry) errors.push('Entry price required');
  if (!setup.stopLoss) errors.push('Stop loss required');
  if (!setup.takeProfit) errors.push('Take profit required');

  // Spot accounts cannot short: a "short" here would just sell coins you may not hold.
  if (setup.direction === 'short') {
    errors.push('Short setups are not supported: this bot trades spot, where shorting is not possible');
  } else if (setup.direction !== 'long') {
    errors.push('Direction must be "long"');
  }

  if (setup.entry && setup.stopLoss && setup.takeProfit) {
    const isLong = setup.direction === 'long';

    // Validate direction consistency
    if (isLong && setup.stopLoss >= setup.entry) {
      errors.push('Long: stop loss must be below entry');
    }
    if (!isLong && setup.stopLoss <= setup.entry) {
      errors.push('Short: stop loss must be above entry');
    }
    if (isLong && setup.takeProfit <= setup.entry) {
      errors.push('Long: take profit must be above entry');
    }
    if (!isLong && setup.takeProfit >= setup.entry) {
      errors.push('Short: take profit must be below entry');
    }

    // Check risk:reward ratio
    const risk = Math.abs(setup.entry - setup.stopLoss);
    const reward = Math.abs(setup.takeProfit - setup.entry);
    const rr = reward / risk;

    if (rr < 1.5) {
      errors.push(`Risk:Reward ${round(rr, 2)} is below minimum 1.5`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function round(n, decimals = 2) {
  return Math.round(n * 10 ** decimals) / 10 ** decimals;
}
