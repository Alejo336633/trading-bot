/**
 * Exchange connection via CCXT.
 * Supports Binance testnet (paper) and mainnet (live).
 */
import ccxt from 'ccxt';
import { config, isPaper } from './config.js';

let exchange = null;

export function getExchange() {
  if (exchange) return exchange;

  const options = {
    apiKey: config.apiKey,
    secret: config.secretKey,
    enableRateLimit: true,
    options: {
      defaultType: 'spot',
    },
  };

  if (isPaper()) {
    // Binance testnet
    exchange = new ccxt.binance({
      ...options,
      sandbox: true,
    });
    console.log('📋 Connected to Binance TESTNET (paper trading)');
  } else {
    exchange = new ccxt.binance(options);
    console.log('⚠️  Connected to Binance LIVE - real money at risk');
  }

  return exchange;
}

/**
 * Get current price for a pair.
 */
export async function getPrice(symbol) {
  const ex = getExchange();
  const ticker = await ex.fetchTicker(symbol);
  return {
    symbol,
    price: ticker.last,
    bid: ticker.bid,
    ask: ticker.ask,
    high: ticker.high,
    low: ticker.low,
    volume: ticker.baseVolume,
    change: ticker.percentage,
    timestamp: ticker.timestamp,
  };
}

/**
 * Get account balance.
 */
export async function getBalance() {
  const ex = getExchange();
  const balance = await ex.fetchBalance();
  const relevant = {};
  for (const [currency, amounts] of Object.entries(balance.total)) {
    if (amounts > 0) {
      relevant[currency] = {
        total: amounts,
        free: balance.free[currency] || 0,
        used: balance.used[currency] || 0,
      };
    }
  }
  return relevant;
}

/**
 * Place a limit buy order.
 */
export async function buyLimit(symbol, amount, price) {
  const ex = getExchange();
  const order = await ex.createLimitBuyOrder(symbol, amount, price);
  return formatOrder(order);
}

/**
 * Place a market buy order.
 */
export async function buyMarket(symbol, amount) {
  const ex = getExchange();
  const order = await ex.createMarketBuyOrder(symbol, amount);
  return formatOrder(order);
}

/**
 * Place a limit sell order.
 */
export async function sellLimit(symbol, amount, price) {
  const ex = getExchange();
  const order = await ex.createLimitSellOrder(symbol, amount, price);
  return formatOrder(order);
}

/**
 * Place a market sell order.
 */
export async function sellMarket(symbol, amount) {
  const ex = getExchange();
  const order = await ex.createMarketSellOrder(symbol, amount);
  return formatOrder(order);
}

/**
 * Cancel an open order.
 */
export async function cancelOrder(orderId, symbol) {
  const ex = getExchange();
  return await ex.cancelOrder(orderId, symbol);
}

/**
 * Get open orders.
 */
export async function getOpenOrders(symbol) {
  const ex = getExchange();
  const orders = await ex.fetchOpenOrders(symbol);
  return orders.map(formatOrder);
}

function formatOrder(order) {
  return {
    id: order.id,
    symbol: order.symbol,
    type: order.type,
    side: order.side,
    price: order.price,
    amount: order.amount,
    filled: order.filled,
    remaining: order.remaining,
    status: order.status,
    timestamp: order.timestamp,
  };
}
