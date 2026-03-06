require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const DB = require('./database');
const DerivSocket = require('./derivSocket');
const registerCommands = require('./commands');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN missing. Copy .env.example to .env and set BOT_TOKEN.');
  process.exit(1);
}

const db = new DB(process.env.DATABASE_PATH);
const deriv = new DerivSocket({ url: process.env.DERIV_WS_URL });
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on('polling_error', (err) => {
  // the 409 code means another getUpdates request is running (e.g. a second
  // container started). We can log a warning but treat it as non-fatal.
  if (err.code === 'ETELEGRAM' && err.response && err.response.body && err.response.body.error_code === 409) {
    console.warn('Telegram polling conflict detected (another instance?) - ignoring');
    return;
  }
  console.error('Telegram polling error', err);
});

registerCommands(bot, db, deriv);


// track recent prices for simple spike/vol logic
const priceHistory = {}; // symbol -> array of {ts, price}

function recordPrice(symbol, price) {
  const now = Date.now();
  if (!priceHistory[symbol]) priceHistory[symbol] = [];
  priceHistory[symbol].push({ts: now, price});
  // keep only last 5 minutes
  const cutoff = now - 5 * 60 * 1000;
  priceHistory[symbol] = priceHistory[symbol].filter(p => p.ts >= cutoff);
}

function evaluateAlert(alert, price) {
  const {chat_id, symbol, type, params, last_type} = alert;
  const p = JSON.parse(params || '{}');
  switch(type) {
    case 'price': {
      const threshold = Number(p.price);
      const dir = p.direction || 'both';
      const last = last_type; // use alert field
      if ((dir==='both'||dir==='below') && price < threshold && last !== 'below') return {text:`🔔 ${symbol} ${price} below ${threshold}`, newType:'below'};
      break;
    }
    case 'zone': {
      const low = Number(p.low), high = Number(p.high);
      if (price >= low && price <= high) return {text:`🟩 ${symbol} price ${price} in zone [${low},${high}]`, newType:'zone'};
      break;
    }
    // spike and volspike left as TODO
    default: break;
  }
  return null;
}

// on tick, run through all enabled alerts, filtering by symbol

let subscribedSymbols = new Set();
deriv.on('tick', (symbol, price) => {
  try {
    recordPrice(symbol, price);
    const alerts = db.getEnabledAlerts().filter(a => a.symbol === symbol);
    console.log(`Processing ${alerts.length} alerts for ${symbol} at price ${price}`);
    alerts.forEach(a => {
      const user = db.getUser(a.chat_id);
      if (!user) {
        console.log(`No user found for chat_id ${a.chat_id}`);
        return;
      }
      const result = evaluateAlert(a, price);
      if (result) {
        const sendAllowed = db.shouldSendAlert(user) || result.newType !== user.last_alert_type;
        console.log(`Alert ${a.id}: result=${result.text}, sendAllowed=${sendAllowed}, userCooldown=${db.shouldSendAlert(user)}, lastType=${user.last_alert_type}`);
        if (!sendAllowed) return;
        bot.sendMessage(a.chat_id, result.text).catch(console.error);
        db.updateAlertState(a.id, result.newType, price);
        db.updateLastAlert(a.chat_id, result.newType, price);
        if (user.autoremove) {
          console.log(`autoremove is on; deleting alert ${a.id}`);
          db.deleteAlert(a.chat_id, a.id);
        }
      } else {
        console.log(`No trigger for alert ${a.id}`);
      }
    });
  } catch (err) {
    console.error('Error handling tick', err);
  }
});


deriv.on('open', () => console.log('Connected to Deriv WebSocket.'));
deriv.on('close', (code, reason) => console.warn('Deriv socket closed', code, reason));
deriv.on('error', (err) => console.error('Deriv socket error', err));

// Subscribe to all stored symbols on startup
(function initialSubscriptions() {
  const alerts = db.getEnabledAlerts();
  alerts.forEach(a => {
    if (!subscribedSymbols.has(a.symbol)) {
      deriv.subscribe(a.symbol);
      subscribedSymbols.add(a.symbol);
    }
  });
})();

console.log('FocusFlow started. Bot is polling.');