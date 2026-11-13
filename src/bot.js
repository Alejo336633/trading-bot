/**
 * Trading Bot — Main entry point.
 * Executes trade setups with full risk management.
 *
 * Usage:
 *   node src/bot.js                     — show status
 *   node src/bot.js execute <setup.json> — execute a trade setup
 *   node src/bot.js close <tradeId>     — close a position
 *   node src/bot.js monitor             — sync with the exchange and show open positions
 *   node src/bot.js sync                — update the journal from the exchange
 *   node src/bot.js protect <tradeId>   — place stop loss + take profit on the exchange
 *   node src/bot.js balance             — show account balance
 *   node src/bot.js stats               — show trade statistics
 */
import { config, isPaper, validateConfig } from './config.js';
import { getPrice, getBalance, buyMarket, buyLimit, sellMarket, fetchOrder, cancelOrder, placeProtection, cancelProtection } from './exchange.js';
import { calculatePositionSize, canOpenTrade, validateSetup } from './risk.js';
import { recordEntry, recordExit, updateTrade, getOpenPositions, getPendingEntries, getStats, loadTrades } from './journal.js';
import { summarizeFill } from './fills.js';
import { syncTrades, protectTrade } from './sync.js';
import { readFileSync } from 'fs';

// Exchange functions the journal sync needs.
const exchangeApi = { fetchOrder, placeProtection };

const [,, command, ...args] = process.argv;

async function main() {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🤖 Trading Bot v1.0');
  console.log(`  Mode: ${isPaper() ? '📋 PAPER (testnet)' : '⚠️  LIVE'}`);
  console.log(`  Capital: $${config.tradingCapital} USDT`);
  console.log(`  Risk/trade: ${config.maxRiskPerTrade * 100}%`);
  console.log(`  Max positions: ${config.maxOpenPositions}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  // Validate config
  const errors = validateConfig();
  const offlineCommands = ['stats', 'help', 'size'];
  if (errors.length > 0 && !offlineCommands.includes(command)) {
    console.log('⚠️  Configuration issues:');
    errors.forEach(e => console.log(`   - ${e}`));
    console.log('');
    console.log('Copy .env.example to .env and set your Binance API keys.');
    console.log('For testnet: https://testnet.binance.vision/');
    console.log('');
    if (!offlineCommands.includes(command)) return;
  }

  switch (command) {
    case 'execute':
      await executeSetup(args[0]);
      break;
    case 'close':
      await closePosition(args[0]);
      break;
    case 'monitor':
      await monitorPositions();
      break;
    case 'sync':
      await runSync();
      break;
    case 'protect':
      await protectPosition(args[0]);
      break;
    case 'balance':
      await showBalance();
      break;
    case 'stats':
      showStats();
      break;
    case 'price':
      await showPrice(args[0]);
      break;
    case 'size':
      calculateSize(args);
      break;
    case 'help':
      showHelp();
      break;
    default:
      showStatus();
      break;
  }
}

async function executeSetup(setupPath) {
  if (!setupPath) {
    console.log('Usage: node src/bot.js execute <setup.json>');
    console.log('');
    console.log('Setup JSON format:');
    console.log(JSON.stringify({
      symbol: 'BTC/USDT',
      direction: 'long',
      entry: 72000,
      stopLoss: 70500,
      takeProfit: 75500,
      reason: 'RSI oversold at 32, support at 72K',
    }, null, 2));
    return;
  }

  // Load setup
  let setup;
  try {
    setup = JSON.parse(readFileSync(setupPath, 'utf-8'));
  } catch {
    console.log(`❌ Cannot read setup file: ${setupPath}`);
    return;
  }

  console.log(`📊 Setup: ${setup.symbol} ${setup.direction.toUpperCase()}`);
  console.log(`   Entry: $${setup.entry}`);
  console.log(`   Stop Loss: $${setup.stopLoss}`);
  console.log(`   Take Profit: $${setup.takeProfit}`);
  console.log('');

  // Validate
  const validation = validateSetup(setup);
  if (!validation.valid) {
    console.log('❌ Setup validation failed:');
    validation.errors.forEach(e => console.log(`   - ${e}`));
    return;
  }
  console.log('✅ Setup validated');

  // Check risk rules
  const riskCheck = canOpenTrade();
  if (!riskCheck.allowed) {
    console.log(`❌ Risk check failed: ${riskCheck.reason}`);
    return;
  }
  console.log(`✅ Risk check passed (${riskCheck.openPositions} open positions)`);

  // Calculate position size
  const sizing = calculatePositionSize(setup.entry, setup.stopLoss);
  console.log('');
  console.log('📐 Position Sizing:');
  console.log(`   Risk amount: $${sizing.riskAmount} (${sizing.riskPercent}% of $${sizing.capital})`);
  console.log(`   Position size: ${sizing.positionUnits} units ($${sizing.positionUSDT})`);
  console.log(`   Stop distance: $${sizing.stopDistance} (${sizing.stopPercent}%)`);
  console.log(`   Max loss: $${sizing.maxLoss}`);
  console.log(`   Est. fee: $${sizing.potentialFee}`);
  if (sizing.needsLeverage) {
    console.log(`   ⚠️  Would need ${sizing.leverage}x leverage (not supported in spot)`);
    console.log('   Reducing to max spot size...');
  }
  console.log('');

  // Execute
  try {
    const currentPrice = await getPrice(setup.symbol);
    console.log(`💰 Current price: $${currentPrice.price}`);

    const amount = sizing.needsLeverage
      ? (config.tradingCapital * 0.95) / setup.entry  // Use 95% of capital max
      : sizing.positionUnits;

    const base = {
      symbol: setup.symbol,
      direction: setup.direction,
      plannedEntry: setup.entry,
      stopLoss: setup.stopLoss,
      takeProfit: setup.takeProfit,
      reason: setup.reason || '',
    };

    if (Math.abs(currentPrice.price - setup.entry) / setup.entry < 0.005) {
      // Within 0.5% of entry — market order, filled immediately
      console.log('🟢 Market BUY (within 0.5% of entry)...');
      const order = await buyMarket(setup.symbol, amount);
      const fill = summarizeFill(order, setup.symbol);
      console.log(`✅ Filled: ${fill.amount} @ $${fill.price} (order ${order.id})`);

      const trade = recordEntry({
        ...base,
        status: 'open',
        entry: fill.price,
        amount: fill.netAmount,
        amountUSDT: fill.cost,
        fees: fill.feeQuote,
        orderId: order.id,
      });
      console.log(`📓 Recorded in journal: ${trade.id}`);
      await tryProtect(trade);
    } else {
      // Limit order at the planned entry: not a position until it fills
      console.log(`📝 Limit BUY at $${setup.entry}...`);
      const order = await buyLimit(setup.symbol, amount, setup.entry);
      console.log(`✅ Order placed: ${order.id} (${order.status})`);

      const trade = recordEntry({
        ...base,
        status: 'pending',
        entry: setup.entry,
        amount,
        amountUSDT: amount * setup.entry,
        orderId: order.id,
      });
      console.log(`📓 Recorded as PENDING: ${trade.id}`);
      console.log('');
      console.log('⏳ Run "node src/bot.js sync" to check the fill. Stop loss and take profit');
      console.log('   are placed on the exchange automatically once the entry fills.');
    }

  } catch (err) {
    console.log(`❌ Execution failed: ${err.message}`);
  }
}

/**
 * Place stop loss + take profit on the exchange; never fail silently.
 */
async function tryProtect(trade) {
  try {
    const protection = await protectTrade(trade, exchangeApi);
    console.log(`🛡️  Stop loss $${trade.stopLoss} and take profit $${trade.takeProfit} placed on the exchange (OCO ${protection.orderListId})`);
    return true;
  } catch (err) {
    console.log('');
    console.log(`🚨 POSITION ${trade.id} HAS NO STOP LOSS ON THE EXCHANGE: ${err.message}`);
    console.log(`   Retry with: node src/bot.js protect ${trade.id}`);
    console.log(`   or close it: node src/bot.js close ${trade.id}`);
    return false;
  }
}

function printSyncEvents(events) {
  for (const e of events) {
    if (e.type === 'filled') console.log(`✅ ${e.id}: entry filled — ${e.amount} @ $${e.price}`);
    else if (e.type === 'protected') console.log(`🛡️  ${e.id}: stop loss and take profit placed (OCO ${e.orderListId})`);
    else if (e.type === 'unprotected') console.log(`🚨 ${e.id}: NO STOP LOSS ON THE EXCHANGE — ${e.message}. Run: node src/bot.js protect ${e.id}`);
    else if (e.type === 'cancelled') console.log(`🚫 ${e.id}: entry order was cancelled without filling`);
    else if (e.type === 'closed') console.log(`${e.pnl >= 0 ? '🟢' : '🔴'} ${e.id}: closed by ${e.reason} @ $${e.price} — P&L $${e.pnl.toFixed(2)}`);
    else if (e.type === 'error') console.log(`⚠️  ${e.id}: could not sync — ${e.message}`);
  }
}

async function runSync() {
  const events = await syncTrades(exchangeApi);
  if (events.length === 0) console.log('Journal is in sync with the exchange. Nothing changed.');
  else printSyncEvents(events);
}

async function protectPosition(tradeId) {
  const unprotected = getOpenPositions().filter(t => !t.protection);
  if (!tradeId) {
    if (unprotected.length === 0) {
      console.log('Every open position already has its stop loss and take profit on the exchange.');
      return;
    }
    console.log('Open positions WITHOUT protection:');
    unprotected.forEach(t => console.log(`  ${t.id} | ${t.symbol} | SL: $${t.stopLoss} | TP: $${t.takeProfit}`));
    console.log('');
    console.log('Usage: node src/bot.js protect <tradeId>');
    return;
  }

  const trade = unprotected.find(t => t.id === tradeId);
  if (!trade) {
    console.log(`❌ Trade ${tradeId} not found, not open, or already protected.`);
    return;
  }
  await tryProtect(trade);
}

async function closePosition(tradeId) {
  if (!tradeId) {
    const open = getOpenPositions();
    const pending = getPendingEntries();
    if (open.length === 0 && pending.length === 0) {
      console.log('No open positions or pending entries.');
      return;
    }
    open.forEach(t => {
      console.log(`  OPEN    ${t.id} | ${t.symbol} ${t.direction} | Entry: $${t.entry} | SL: $${t.stopLoss} | TP: $${t.takeProfit}`);
    });
    pending.forEach(t => {
      console.log(`  PENDING ${t.id} | ${t.symbol} ${t.direction} | Limit: $${t.plannedEntry}`);
    });
    console.log('');
    console.log('Usage: node src/bot.js close <tradeId>');
    return;
  }

  const trade = loadTrades().find(t => t.id === tradeId && ['open', 'pending'].includes(t.status));
  if (!trade) {
    console.log(`❌ Trade ${tradeId} not found or not open.`);
    return;
  }

  try {
    if (trade.status === 'pending') {
      await cancelOrder(trade.entryOrderId, trade.symbol);
      updateTrade(trade.id, { status: 'cancelled', closedAt: new Date().toISOString() });
      console.log(`🚫 Pending entry ${trade.id} cancelled.`);
      return;
    }

    // Free the coins held by the protective orders before selling.
    if (trade.protection) {
      await cancelProtection(trade.symbol, trade.protection.orderListId);
      updateTrade(trade.id, { protection: null });
      console.log('Protective orders cancelled.');
    }

    console.log(`Closing ${trade.symbol} ${trade.direction} at market...`);
    const order = await sellMarket(trade.symbol, trade.amount);
    const fill = summarizeFill(order, trade.symbol);

    const closed = recordExit(tradeId, fill.price, fill.feeQuote, 'manual');
    console.log(`✅ Position closed @ $${fill.price}. P&L: $${closed.pnl.toFixed(2)} (${closed.pnlPercent.toFixed(2)}%)`);
  } catch (err) {
    console.log(`❌ Close failed: ${err.message}`);
    console.log('   Check the position on the exchange: it may now be without protection.');
  }
}

async function monitorPositions() {
  // First bring the journal in line with the exchange (fills, stops hit).
  printSyncEvents(await syncTrades(exchangeApi));

  const pending = getPendingEntries();
  pending.forEach(t => console.log(`⏳ ${t.id} | ${t.symbol} — limit entry at $${t.plannedEntry} not filled yet`));

  const open = getOpenPositions();
  if (open.length === 0) {
    console.log('No open positions to monitor.');
    return;
  }

  console.log('📊 Monitoring open positions...');
  console.log('');

  for (const trade of open) {
    try {
      const current = await getPrice(trade.symbol);
      const unrealizedPnL = trade.direction === 'long'
        ? (current.price - trade.entry) * trade.amount
        : (trade.entry - current.price) * trade.amount;

      const pnlPercent = (unrealizedPnL / trade.amountUSDT) * 100;
      const hitSL = trade.direction === 'long'
        ? current.price <= trade.stopLoss
        : current.price >= trade.stopLoss;
      const hitTP = trade.direction === 'long'
        ? current.price >= trade.takeProfit
        : current.price <= trade.takeProfit;

      const status = hitSL ? '🔴 STOP LOSS HIT' : hitTP ? '🟢 TAKE PROFIT HIT' : '⏳ Active';

      console.log(`${trade.id} | ${trade.symbol} ${trade.direction.toUpperCase()}`);
      console.log(`  Entry: $${trade.entry} | Now: $${current.price} | P&L: $${unrealizedPnL.toFixed(2)} (${pnlPercent.toFixed(2)}%)`);
      console.log(`  SL: $${trade.stopLoss} | TP: $${trade.takeProfit} | ${status}`);
      console.log(trade.protection
        ? `  🛡️  Protected on the exchange (OCO ${trade.protection.orderListId})`
        : `  🚨 NO STOP LOSS ON THE EXCHANGE — run: node src/bot.js protect ${trade.id}`);
      console.log('');
    } catch (err) {
      console.log(`${trade.id} | ${trade.symbol} — Error: ${err.message}`);
    }
  }
}

async function showBalance() {
  try {
    const balance = await getBalance();
    console.log('💰 Account Balance:');
    for (const [currency, amounts] of Object.entries(balance)) {
      console.log(`  ${currency}: ${amounts.total} (free: ${amounts.free}, in orders: ${amounts.used})`);
    }
  } catch (err) {
    console.log(`❌ Error fetching balance: ${err.message}`);
  }
}

async function showPrice(symbol) {
  if (!symbol) {
    console.log('Usage: node src/bot.js price BTC/USDT');
    return;
  }
  try {
    const price = await getPrice(symbol);
    console.log(`${price.symbol}: $${price.price} (24h: ${price.change > 0 ? '+' : ''}${price.change?.toFixed(2)}%)`);
    console.log(`  High: $${price.high} | Low: $${price.low} | Vol: ${price.volume}`);
  } catch (err) {
    console.log(`❌ Error: ${err.message}`);
  }
}

function calculateSize(args) {
  const [entry, stopLoss, capital] = args.map(Number);
  if (!entry || !stopLoss) {
    console.log('Usage: node src/bot.js size <entry> <stopLoss> [capital]');
    console.log('Example: node src/bot.js size 72000 70500 1000');
    return;
  }
  const sizing = calculatePositionSize(entry, stopLoss, capital);
  console.log(JSON.stringify(sizing, null, 2));
}

function showStats() {
  const stats = getStats();
  if (stats.trades === 0 && stats.message) {
    console.log(stats.message);
    return;
  }
  console.log('📈 Trading Statistics:');
  console.log(`  Total trades: ${stats.totalTrades}`);
  console.log(`  Open positions: ${stats.openPositions}`);
  console.log(`  Win rate: ${stats.winRate}% (${stats.wins}W / ${stats.losses}L)`);
  console.log(`  Total P&L: $${stats.totalPnL}`);
  console.log(`  Avg win: $${stats.avgWin} | Avg loss: $${stats.avgLoss}`);
  console.log(`  Profit factor: ${stats.profitFactor}`);
  console.log(`  Best: $${stats.bestTrade} | Worst: $${stats.worstTrade}`);
}

function showStatus() {
  const open = getOpenPositions();
  const stats = getStats();
  console.log(`Open positions: ${open.length}`);
  if (open.length > 0) {
    open.forEach(t => {
      console.log(`  ${t.id} | ${t.symbol} ${t.direction} @ $${t.entry}`);
    });
  }
  console.log('');
  if (stats.totalTrades > 0) {
    console.log(`Closed trades: ${stats.totalTrades} | Win rate: ${stats.winRate}% | P&L: $${stats.totalPnL}`);
  }
  console.log('');
  console.log('Commands: execute, close, monitor, sync, protect, balance, price, size, stats, help');
}

function showHelp() {
  console.log('Commands:');
  console.log('  execute <setup.json>  Execute a trade setup from JSON file');
  console.log('  close [tradeId]       Close a position (lists open if no ID)');
  console.log('  monitor               Sync with the exchange, then show open positions');
  console.log('  sync                  Update the journal from the exchange (fills, stops hit)');
  console.log('  protect [tradeId]     Place stop loss + take profit on the exchange for a position');
  console.log('  balance               Show account balance');
  console.log('  price <PAIR>          Show current price (e.g., BTC/USDT)');
  console.log('  size <entry> <sl>     Calculate position size');
  console.log('  stats                 Show trading statistics');
  console.log('  help                  Show this help');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
