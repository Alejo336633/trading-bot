/**
 * Bot configuration - loads from .env or uses safe defaults for testnet.
 */
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Simple .env parser (no dependencies)
function loadEnv() {
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) return {};
  const env = {};
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    env[key] = val;
  }
  return env;
}

const env = loadEnv();

export const config = {
  // Binance API
  apiKey: env.BINANCE_API_KEY || '',
  secretKey: env.BINANCE_SECRET_KEY || '',

  // Mode: 'paper' (testnet) or 'live' (real money)
  mode: env.TRADING_MODE || 'paper',

  // Risk management
  maxRiskPerTrade: parseFloat(env.MAX_RISK_PER_TRADE || '0.02'),   // 2% per trade
  maxOpenPositions: parseInt(env.MAX_OPEN_POSITIONS || '3'),         // max 3 positions
  maxDailyLoss: parseFloat(env.MAX_DAILY_LOSS || '0.05'),           // 5% daily max loss

  // Capital
  tradingCapital: parseFloat(env.TRADING_CAPITAL || '1000'),         // USDT

  // Paths
  tradesPath: resolve(ROOT, 'trades.json'),

  // Supported pairs for the bot
  pairs: ['BTC/USDT', 'ETH/USDT'],

  // Minimum order sizes (Binance)
  minOrder: {
    'BTC/USDT': 0.00001,
    'ETH/USDT': 0.001,
  },
};

export function isPaper() {
  return config.mode === 'paper';
}

export function validateConfig() {
  const errors = [];
  if (!config.apiKey) errors.push('BINANCE_API_KEY not set');
  if (!config.secretKey) errors.push('BINANCE_SECRET_KEY not set');
  if (config.maxRiskPerTrade > 0.05) errors.push('MAX_RISK_PER_TRADE > 5% is dangerous');
  if (config.mode === 'live' && config.tradingCapital > 10000) {
    errors.push('Capital > $10,000 in live mode - double check this is intentional');
  }
  return errors;
}
