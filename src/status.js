#!/usr/bin/env node
import { config, isPaper } from './config.js';
import { getExchange, getPrice, getBalance } from './exchange.js';
import { getOpenPositions } from './journal.js';

async function main() {
  console.log(`\n🤖 Trading Bot Status — ${isPaper() ? 'PAPER' : 'LIVE'} mode\n`);

  const open = getOpenPositions();
  console.log(`📊 Open Positions: ${open.length}/${config.maxOpenPositions}`);

  if (open.length > 0) {
    for (const trade of open) {
      try {
        const current = await getPrice(trade.symbol);
        const pnl = trade.direction === 'long'
          ? (current.price - trade.entry) * trade.amount
          : (trade.entry - current.price) * trade.amount;
        const pct = (pnl / trade.amountUSDT) * 100;
        const icon = pnl >= 0 ? '🟢' : '🔴';
        console.log(`  ${icon} ${trade.id} | ${trade.symbol} ${trade.direction} @ $${trade.entry}`);
        console.log(`     Now: $${current.price} | P&L: $${pnl.toFixed(2)} (${pct.toFixed(2)}%)`);
        console.log(`     SL: $${trade.stopLoss} | TP: $${trade.takeProfit}`);
      } catch {
        console.log(`  ⚠️  ${trade.id} | ${trade.symbol} — could not fetch price`);
      }
    }
  } else {
    console.log('  No open positions.');
  }

  console.log('');

  try {
    const balance = await getBalance();
    console.log('💰 Balance:');
    for (const [cur, amt] of Object.entries(balance)) {
      console.log(`  ${cur}: ${amt.total} (free: ${amt.free})`);
    }
  } catch (err) {
    console.log(`💰 Balance: unavailable (${err.message})`);
  }

  console.log('');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
