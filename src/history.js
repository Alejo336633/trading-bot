#!/usr/bin/env node
import { loadTrades, getStats } from './journal.js';

const [,, filter] = process.argv;

function main() {
  const trades = loadTrades();

  if (trades.length === 0) {
    console.log('\nNo trades recorded yet.\n');
    console.log('Execute a setup: node src/bot.js execute setup.json');
    return;
  }

  const stats = getStats();

  console.log('\n📈 Trade History');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (stats.totalTrades > 0) {
    console.log(`  Closed: ${stats.totalTrades} | Win rate: ${stats.winRate}% | P&L: $${stats.totalPnL}`);
    console.log(`  Wins: ${stats.wins} (avg $${stats.avgWin}) | Losses: ${stats.losses} (avg $${stats.avgLoss})`);
    console.log(`  Best: $${stats.bestTrade} | Worst: $${stats.worstTrade} | PF: ${stats.profitFactor}`);
    console.log('');
  }

  const list = filter === 'open'
    ? trades.filter(t => t.status === 'open')
    : filter === 'closed'
      ? trades.filter(t => t.status === 'closed')
      : trades;

  console.log(`Showing: ${filter || 'all'} (${list.length} trades)\n`);

  for (const t of list.reverse()) {
    const pnlStr = t.pnl !== null
      ? `P&L: $${t.pnl.toFixed(2)} (${t.pnlPercent.toFixed(2)}%)`
      : 'P&L: pending';
    const statusIcon = t.status === 'open' ? '⏳' : t.pnl > 0 ? '✅' : '❌';

    console.log(`${statusIcon} ${t.id} | ${t.symbol} ${t.direction.toUpperCase()}`);
    console.log(`   Entry: $${t.entry} | Exit: ${t.exitPrice ? '$' + t.exitPrice : '—'} | ${pnlStr}`);
    console.log(`   SL: $${t.stopLoss} | TP: $${t.takeProfit}`);
    console.log(`   Opened: ${t.openedAt}${t.closedAt ? ' | Closed: ' + t.closedAt : ''}`);
    if (t.reason) console.log(`   Reason: ${t.reason}`);
    console.log('');
  }
}

main();
