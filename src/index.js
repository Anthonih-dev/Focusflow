require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const { createDb } = require('./db');
const { DerivStream } = require('./derivClient');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DERIV_APP_ID = process.env.DERIV_APP_ID || '1089';
const DB_PATH = process.env.DB_PATH || './alerts.db';

if (!TELEGRAM_TOKEN) {
  throw new Error('Missing TELEGRAM_BOT_TOKEN in environment');
}

const SYMBOL_MAP = {
  V75: 'R_75',
  V100: 'R_100',
  BOOM1000: 'BOOM1000',
  BOOM500: 'BOOM500',
  CRASH500: 'CRASH500',
  CRASH1000: 'CRASH1000',
  STEP: 'STEPINDEX',
  STEPINDEX: 'STEPINDEX'
};

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const { stmts } = createDb(DB_PATH);

const lastPrices = new Map();
const tickHistory = new Map();

function normalizeSymbol(raw) {
  const key = raw.toUpperCase().replace(/\s+/g, '');
  return SYMBOL_MAP[key] || key;
}

function formatAlert(alert) {
  if (alert.type === 'touch') return `#${alert.id} TOUCH ${alert.symbol} @ ${alert.target_price}`;
  if (alert.type === 'breakout') return `#${alert.id} BREAKOUT ${alert.symbol} ${alert.direction} ${alert.target_price}`;
  if (alert.type === 'zone') return `#${alert.id} ZONE ${alert.symbol} ${alert.zone_low}-${alert.zone_high}`;
  if (alert.type === 'spike') return `#${alert.id} SPIKE ${alert.symbol} threshold=${alert.threshold} in ${alert.window_seconds}s`;
  if (alert.type === 'vol_spike') return `#${alert.id} VOL_SPIKE ${alert.symbol} ${alert.threshold}% in ${alert.window_seconds}s`;
  return `#${alert.id} ${alert.type} ${alert.symbol}`;
}

function ensureUser(msg) {
  const user = msg.from;
  stmts.upsertUser.run({
    telegram_id: user.id,
    username: user.username || null,
    first_name: user.first_name || null
  });
  return stmts.getUser.get(user.id);
}

function addAlert(payload) {
  const info = stmts.createAlert.run(payload);
  stream.ensureSymbol(payload.symbol);
  return info.lastInsertRowid;
}

function maybeUnsubscribeSymbol(symbol) {
  const count = stmts.countAlertsForSymbol.get(symbol).count;
  if (count === 0) stream.removeSymbol(symbol);
}

function parseSetCommand(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3) return null;
  const symbol = normalizeSymbol(parts[1]);
  const target = Number(parts[2]);
  if (!Number.isFinite(target)) return null;
  const direction = parts[3] ? parts[3].toLowerCase() : null;
  return {
    symbol,
    type: direction === 'above' || direction === 'below' ? 'breakout' : 'touch',
    direction: direction === 'above' || direction === 'below' ? direction : null,
    target
  };
}

function pushTick(symbol, price, epoch) {
  if (!tickHistory.has(symbol)) tickHistory.set(symbol, []);
  const history = tickHistory.get(symbol);
  history.push({ price, epoch });
  const cutoff = epoch - 120;
  while (history.length && history[0].epoch < cutoff) history.shift();
}

async function triggerAlert(alert, price, reason) {
  const user = stmts.getUser.get(alert.telegram_id);
  if (!user || user.muted) return;

  await bot.sendMessage(
    alert.telegram_id,
    `🚨 Alert triggered\n${formatAlert(alert)}\nPrice: ${price}\nReason: ${reason}`
  );

  stmts.touchAlert.run(alert.id);
  if (user.auto_remove) {
    stmts.deleteAlertById.run(alert.id);
    maybeUnsubscribeSymbol(alert.symbol);
  }
}

async function evaluateAlerts(symbol, price) {
  const prev = lastPrices.get(symbol);
  const alerts = stmts.listAlertsBySymbol.all(symbol);

  for (const alert of alerts) {
    if (alert.type === 'touch') {
      if (Math.abs(price - alert.target_price) < 1e-9 || (prev !== undefined && ((prev < alert.target_price && price >= alert.target_price) || (prev > alert.target_price && price <= alert.target_price)))) {
        await triggerAlert(alert, price, `Price touched ${alert.target_price}`);
      }
    }

    if (alert.type === 'breakout') {
      if (alert.direction === 'above' && prev !== undefined && prev <= alert.target_price && price > alert.target_price) {
        await triggerAlert(alert, price, `Breakout above ${alert.target_price}`);
      }
      if (alert.direction === 'below' && prev !== undefined && prev >= alert.target_price && price < alert.target_price) {
        await triggerAlert(alert, price, `Breakout below ${alert.target_price}`);
      }
    }

    if (alert.type === 'zone') {
      const inZone = price >= alert.zone_low && price <= alert.zone_high;
      const wasInZone = prev !== undefined && prev >= alert.zone_low && prev <= alert.zone_high;
      if (inZone && !wasInZone) {
        await triggerAlert(alert, price, `Entered zone ${alert.zone_low}-${alert.zone_high}`);
      }
    }

    if (alert.type === 'spike') {
      const history = tickHistory.get(symbol) || [];
      const cutoff = (history[history.length - 1]?.epoch || 0) - alert.window_seconds;
      const window = history.filter((h) => h.epoch >= cutoff);
      if (window.length >= 2) {
        const low = Math.min(...window.map((h) => h.price));
        const high = Math.max(...window.map((h) => h.price));
        if (high - low >= alert.threshold) {
          await triggerAlert(alert, price, `Spike detected range=${(high - low).toFixed(2)}`);
        }
      }
    }

    if (alert.type === 'vol_spike') {
      const history = tickHistory.get(symbol) || [];
      const cutoff = (history[history.length - 1]?.epoch || 0) - alert.window_seconds;
      const window = history.filter((h) => h.epoch >= cutoff);
      if (window.length >= 2) {
        const first = window[0].price;
        const movePct = Math.abs((price - first) / first) * 100;
        if (movePct >= alert.threshold) {
          await triggerAlert(alert, price, `Volatility spike ${movePct.toFixed(3)}%`);
        }
      }
    }
  }

  lastPrices.set(symbol, price);
}

const stream = new DerivStream({
  appId: DERIV_APP_ID,
  onTick: async ({ symbol, price, epoch }) => {
    pushTick(symbol, price, epoch);
    await evaluateAlerts(symbol, price);
  },
  onStatus: (status) => {
    if (!status.startsWith('connected')) console.log(`[Deriv] ${status}`);
  }
});

stream.connect();
for (const row of stmts.getAllSymbols.all()) {
  stream.ensureSymbol(row.symbol);
}

bot.onText(/\/start/, (msg) => {
  ensureUser(msg);
  bot.sendMessage(
    msg.chat.id,
    `Welcome to Deriv Synthetic Alerts Bot.\n\nCommands:\n/set SYMBOL PRICE [above|below]\n/zone SYMBOL LOW HIGH\n/spike SYMBOL THRESHOLD [WINDOW_SECONDS]\n/volspike SYMBOL THRESHOLD_PERCENT [WINDOW_SECONDS]\n/list\n/delete ALERT_ID\n/clear SYMBOL\n/mute\n/unmute\n/autoremove on|off\n/risk account_size risk_percent stop_loss_points`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'List Alerts', callback_data: 'list' }, { text: 'Mute/Unmute', callback_data: 'toggle_mute' }],
          [{ text: 'Auto-remove Toggle', callback_data: 'toggle_auto_remove' }]
        ]
      }
    }
  );
});

bot.onText(/\/set (.+)/, (msg) => {
  const user = ensureUser(msg);
  const parsed = parseSetCommand(`/set ${msg.match[1]}`);
  if (!parsed) {
    bot.sendMessage(msg.chat.id, 'Usage: /set SYMBOL PRICE [above|below]');
    return;
  }

  const alertId = addAlert({
    telegram_id: user.telegram_id,
    symbol: parsed.symbol,
    type: parsed.type,
    direction: parsed.direction,
    target_price: parsed.target,
    zone_low: null,
    zone_high: null,
    threshold: null,
    window_seconds: null
  });

  bot.sendMessage(msg.chat.id, `✅ Alert created: #${alertId} ${parsed.type} ${parsed.symbol}`);
});

bot.onText(/\/zone (.+)/, (msg) => {
  const user = ensureUser(msg);
  const parts = msg.match[1].trim().split(/\s+/);
  if (parts.length < 3) {
    bot.sendMessage(msg.chat.id, 'Usage: /zone SYMBOL LOW HIGH');
    return;
  }

  const symbol = normalizeSymbol(parts[0]);
  const low = Number(parts[1]);
  const high = Number(parts[2]);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low >= high) {
    bot.sendMessage(msg.chat.id, 'Invalid zone. LOW must be < HIGH');
    return;
  }

  const alertId = addAlert({
    telegram_id: user.telegram_id,
    symbol,
    type: 'zone',
    direction: null,
    target_price: null,
    zone_low: low,
    zone_high: high,
    threshold: null,
    window_seconds: null
  });

  bot.sendMessage(msg.chat.id, `✅ Zone alert created: #${alertId} ${symbol} ${low}-${high}`);
});

bot.onText(/\/spike (.+)/, (msg) => {
  const user = ensureUser(msg);
  const [rawSymbol, rawThreshold, rawWindow] = msg.match[1].trim().split(/\s+/);
  const symbol = normalizeSymbol(rawSymbol || '');
  const threshold = Number(rawThreshold);
  const windowSeconds = Number(rawWindow || 5);

  if (!Number.isFinite(threshold) || !Number.isFinite(windowSeconds)) {
    bot.sendMessage(msg.chat.id, 'Usage: /spike SYMBOL THRESHOLD [WINDOW_SECONDS]');
    return;
  }

  const alertId = addAlert({
    telegram_id: user.telegram_id,
    symbol,
    type: 'spike',
    direction: null,
    target_price: null,
    zone_low: null,
    zone_high: null,
    threshold,
    window_seconds: windowSeconds
  });

  bot.sendMessage(msg.chat.id, `✅ Spike alert created: #${alertId} ${symbol}`);
});

bot.onText(/\/volspike (.+)/, (msg) => {
  const user = ensureUser(msg);
  const [rawSymbol, rawThreshold, rawWindow] = msg.match[1].trim().split(/\s+/);
  const symbol = normalizeSymbol(rawSymbol || '');
  const threshold = Number(rawThreshold);
  const windowSeconds = Number(rawWindow || 10);

  if (!Number.isFinite(threshold) || !Number.isFinite(windowSeconds)) {
    bot.sendMessage(msg.chat.id, 'Usage: /volspike SYMBOL THRESHOLD_PERCENT [WINDOW_SECONDS]');
    return;
  }

  const alertId = addAlert({
    telegram_id: user.telegram_id,
    symbol,
    type: 'vol_spike',
    direction: null,
    target_price: null,
    zone_low: null,
    zone_high: null,
    threshold,
    window_seconds: windowSeconds
  });

  bot.sendMessage(msg.chat.id, `✅ Volatility spike alert created: #${alertId} ${symbol}`);
});

bot.onText(/\/list/, (msg) => {
  const user = ensureUser(msg);
  const alerts = stmts.listAlertsByUser.all(user.telegram_id);
  if (!alerts.length) {
    bot.sendMessage(msg.chat.id, 'No active alerts.');
    return;
  }

  const lines = alerts.map((a) => formatAlert(a));
  const keyboard = alerts.slice(0, 10).map((a) => [{ text: `Delete #${a.id}`, callback_data: `delete:${a.id}` }]);
  bot.sendMessage(msg.chat.id, `Active alerts:\n${lines.join('\n')}`, {
    reply_markup: { inline_keyboard: keyboard }
  });
});

bot.onText(/\/delete (.+)/, (msg) => {
  const user = ensureUser(msg);
  const id = Number(msg.match[1]);
  if (!Number.isInteger(id)) {
    bot.sendMessage(msg.chat.id, 'Usage: /delete ALERT_ID');
    return;
  }
  const alert = stmts.getAlertByIdForUser.get(id, user.telegram_id);
  if (!alert) {
    bot.sendMessage(msg.chat.id, `Alert #${id} not found.`);
    return;
  }
  stmts.deleteAlertByIdForUser.run(id, user.telegram_id);
  maybeUnsubscribeSymbol(alert.symbol);
  bot.sendMessage(msg.chat.id, `🗑 Deleted alert #${id}`);
});

bot.onText(/\/clear (.+)/, (msg) => {
  const user = ensureUser(msg);
  const symbol = normalizeSymbol(msg.match[1].trim());
  const result = stmts.clearAlertsForUserSymbol.run(user.telegram_id, symbol);
  maybeUnsubscribeSymbol(symbol);
  bot.sendMessage(msg.chat.id, `Cleared ${result.changes} alert(s) for ${symbol}`);
});

bot.onText(/\/mute/, (msg) => {
  const user = ensureUser(msg);
  stmts.setMute.run(1, user.telegram_id);
  bot.sendMessage(msg.chat.id, '🔕 Notifications muted.');
});

bot.onText(/\/unmute/, (msg) => {
  const user = ensureUser(msg);
  stmts.setMute.run(0, user.telegram_id);
  bot.sendMessage(msg.chat.id, '🔔 Notifications enabled.');
});

bot.onText(/\/autoremove (.+)/, (msg) => {
  const user = ensureUser(msg);
  const value = msg.match[1].trim().toLowerCase();
  if (!['on', 'off'].includes(value)) {
    bot.sendMessage(msg.chat.id, 'Usage: /autoremove on|off');
    return;
  }
  stmts.setAutoRemove.run(value === 'on' ? 1 : 0, user.telegram_id);
  bot.sendMessage(msg.chat.id, `Auto-remove is now ${value.toUpperCase()}`);
});

bot.onText(/\/risk (.+)/, (msg) => {
  ensureUser(msg);
  const [accountRaw, riskRaw, slRaw] = msg.match[1].trim().split(/\s+/);
  const accountSize = Number(accountRaw);
  const riskPct = Number(riskRaw);
  const stopLossPoints = Number(slRaw);

  if (![accountSize, riskPct, stopLossPoints].every(Number.isFinite) || stopLossPoints <= 0) {
    bot.sendMessage(msg.chat.id, 'Usage: /risk account_size risk_percent stop_loss_points');
    return;
  }

  const riskAmount = accountSize * (riskPct / 100);
  const perPoint = riskAmount / stopLossPoints;

  bot.sendMessage(
    msg.chat.id,
    `Risk calculation:\nAccount: ${accountSize}\nRisk: ${riskPct}% (${riskAmount.toFixed(2)})\nStop loss: ${stopLossPoints} points\nMax value per point: ${perPoint.toFixed(4)}`
  );
});

bot.on('callback_query', (query) => {
  const msg = query.message;
  const user = ensureUser({ from: query.from });
  const data = query.data;

  if (data === 'list') {
    const alerts = stmts.listAlertsByUser.all(user.telegram_id);
    bot.sendMessage(msg.chat.id, alerts.length ? alerts.map(formatAlert).join('\n') : 'No active alerts.');
  }

  if (data === 'toggle_mute') {
    const next = user.muted ? 0 : 1;
    stmts.setMute.run(next, user.telegram_id);
    bot.sendMessage(msg.chat.id, next ? '🔕 Muted.' : '🔔 Unmuted.');
  }

  if (data === 'toggle_auto_remove') {
    const next = user.auto_remove ? 0 : 1;
    stmts.setAutoRemove.run(next, user.telegram_id);
    bot.sendMessage(msg.chat.id, `Auto-remove ${next ? 'ON' : 'OFF'}.`);
  }

  if (data.startsWith('delete:')) {
    const id = Number(data.split(':')[1]);
    const alert = stmts.getAlertByIdForUser.get(id, user.telegram_id);
    if (alert) {
      stmts.deleteAlertByIdForUser.run(id, user.telegram_id);
      maybeUnsubscribeSymbol(alert.symbol);
      bot.sendMessage(msg.chat.id, `Deleted #${id}`);
    }
  }

  bot.answerCallbackQuery(query.id).catch(() => {});
});

process.on('SIGINT', () => {
  stream.close();
  process.exit(0);
});
