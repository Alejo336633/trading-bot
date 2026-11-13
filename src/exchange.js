/**
 * Exchange connection via CCXT.
 * Supports Binance testnet (paper) and mainnet (live).
 */
import ccxt from 'ccxt';
import { config, isPaper } from './config.js';

// How far below the stop trigger the stop-limit order may fill (0.2%).
const STOP_LIMIT_SLIPPAGE = 0.002;

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
 * Fetch one order with its real fill data.
 */
export async function fetchOrder(orderId, symbol) {
  const ex = getExchange();
  return formatOrder(await ex.fetchOrder(orderId, symbol));
}

/**
 * Place the protective pair for a long position as one OCO order list:
 * a take profit (limit) above the price and a stop loss below it. When one
 * fills, Binance cancels the other. The orders live on the exchange, so they
 * work even when the bot is not running.
 */
export async function placeProtection(symbol, amount, takeProfit, stopLoss) {
  const ex = getExchange();
  await ex.loadMarkets();
  const market = ex.market(symbol);

  const response = await ex.privatePostOrderListOco({
    symbol: market.id,
    side: 'SELL',
    quantity: ex.amountToPrecision(symbol, amount),
    aboveType: 'LIMIT_MAKER',
    abovePrice: ex.priceToPrecision(symbol, takeProfit),
    belowType: 'STOP_LOSS_LIMIT',
    belowStopPrice: ex.priceToPrecision(symbol, stopLoss),
    // Limit slightly under the trigger so the stop still fills in a fast move.
    belowPrice: ex.priceToPrecision(symbol, stopLoss * (1 - STOP_LIMIT_SLIPPAGE)),
    belowTimeInForce: 'GTC',
  });

  const reports = response.orderReports || [];
  const tp = reports.find(o => o.type === 'LIMIT_MAKER');
  const sl = reports.find(o => o.type === 'STOP_LOSS_LIMIT');
  if (!tp || !sl) throw new Error('Exchange did not return both protective orders');

  return {
    orderListId: String(response.orderListId),
    tpOrderId: String(tp.orderId),
    slOrderId: String(sl.orderId),
  };
}

/**
 * Cancel a protective OCO order list (before closing a position manually).
 */
export async function cancelProtection(symbol, orderListId) {
  const ex = getExchange();
  await ex.loadMarkets();
  return await ex.privateDeleteOrderList({ symbol: ex.market(symbol).id, orderListId });
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
    average: order.average,
    cost: order.cost,
    fee: order.fee,
    fees: order.fees,
    amount: order.amount,
    filled: order.filled,
    remaining: order.remaining,
    status: order.status,
    timestamp: order.timestamp,
  };
}
