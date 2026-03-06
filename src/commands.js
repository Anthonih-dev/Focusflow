function registerCommands(bot, db, deriv) {
  // track processed messages to avoid duplicates (Telegram sometimes delivers
  // the same update twice, especially during reconnects or polling hiccups).
  const seen = new Set(); // keys of form `${chatId}:${messageId}`

  bot.on('message', (msg) => {
    const key = `${msg.chat.id}:${msg.message_id}`;
    if (seen.has(key)) {
      console.log('duplicate message ignored', key, msg.text);
      return;
    }
    seen.add(key);
    // expire after a minute to avoid unbounded growth
    setTimeout(() => seen.delete(key), 60 * 1000);
  });

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Welcome to FocusFlow! Use /help for commands.');
    if (!db.getUser(msg.chat.id)) db.upsertUser({ chat_id: msg.chat.id });
  });

  bot.onText(/\/help/, (msg) => {
    const text =
`Commands:
/set SYMBOL PRICE [above|below]
/zone SYMBOL LOW HIGH
/spike SYMBOL THRESHOLD [WINDOW_SECONDS]
/volspike SYMBOL THRESHOLD_PERCENT [WINDOW_SECONDS]
/list                 - list all your alerts
/delete ALERT_ID      - delete an alert
/clear SYMBOL         - remove alerts for a symbol
/mute                 - silence alerts temporarily
/unmute               - resume alerts
/autoremove on|off    - auto-delete triggered alerts
/risk size pct pts    - set risk parameters
/status               - show user settings
/help                 - show this message`;
    bot.sendMessage(msg.chat.id, text);
  });

  // general alert creation syntax helper
  function addAlert(msg, type, symbol, params) {    // ensure user exists (create if not)
    if (!db.getUser(msg.chat_id)) {
      db.upsertUser({ chat_id: msg.chat_id });
    }    // avoid creating the same alert twice in a row
    const existing = db.listAlerts(msg.chat.id).find(a =>
      a.type === type && a.symbol === symbol && JSON.stringify(a.params) === JSON.stringify(params)
    );
    if (existing) {
      console.log('duplicate alert suppressed', msg.chat.id, type, symbol, params);
      bot.sendMessage(msg.chat.id, `That alert already exists.`);
      return;
    }
    db.addAlert(msg.chat.id, symbol, type, params);
    deriv.subscribe(symbol);
    bot.sendMessage(msg.chat.id, `Alert created (type=${type}, symbol=${symbol}).`);
  }

  bot.onText(/\/set (\S+) (\S+)(?:\s+(above|below))?/, (msg, match) => {
    // /set SYMBOL PRICE [above|below]
    const symbol = match[1];
    const price = parseFloat(match[2]);
    if (Number.isNaN(price)) return bot.sendMessage(msg.chat.id,'invalid price');
    const dir = match[3] || 'both';
    addAlert(msg, 'price', symbol, {price, direction: dir});
  });

  bot.onText(/\/zone (\S+) (\S+) (\S+)/, (msg, match) => {
    // /zone SYMBOL LOW HIGH
    const [_, symbol, low, high] = match;
    const l = parseFloat(low), h = parseFloat(high);
    if (Number.isNaN(l)||Number.isNaN(h)) return bot.sendMessage(msg.chat.id,'invalid zone');
    addAlert(msg,'zone',symbol,{low:l,high:h});
  });

  bot.onText(/\/spike (\S+) (\S+)(?:\s+(\d+))?/, (msg, match) => {
    // /spike SYMBOL THRESHOLD [WINDOW_SECONDS]
    const symbol=match[1];
    const th=parseFloat(match[2]);
    const w=match[3]?parseInt(match[3],10):60;
    if(Number.isNaN(th)) return bot.sendMessage(msg.chat.id,'invalid threshold');
    addAlert(msg,'spike',symbol,{threshold:th,window:w});
  });

  bot.onText(/\/volspike (\S+) (\S+)(?:\s+(\d+))?/, (msg, match) => {
    // /volspike SYMBOL THRESHOLD_PERCENT [WINDOW_SECONDS]
    const symbol=match[1];
    const th=parseFloat(match[2]);
    const w=match[3]?parseInt(match[3],10):60;
    if(Number.isNaN(th)) return bot.sendMessage(msg.chat.id,'invalid threshold');
    addAlert(msg,'volspike',symbol,{percent:th,window:w});
  });

  bot.onText(/\/list/, (msg) => {
    const alerts=db.listAlerts(msg.chat.id);
    if(alerts.length===0) return bot.sendMessage(msg.chat.id,'no alerts');
    const lines=alerts.map(a=>`${a.id}: ${a.type} ${a.symbol} ${a.params}`);
    bot.sendMessage(msg.chat.id,lines.join("\n"));
  });

  bot.onText(/\/delete (\d+)/, (msg,match)=>{
    db.deleteAlert(msg.chat.id,parseInt(match[1],10));
    bot.sendMessage(msg.chat.id,'deleted');
  });

  bot.onText(/\/clear (\S+)/,(msg,match)=>{
    db.clearAlertsForSymbol(msg.chat.id,match[1]);
    bot.sendMessage(msg.chat.id,'cleared');
  });

  bot.onText(/\/mute/,msg=>{
    db.setUserCooldown(msg.chat.id, null);
    bot.sendMessage(msg.chat.id,'muted (no alerts)');
  });
  bot.onText(/\/unmute/,msg=>{
    // restore default; no-op here as alerts_enabled flag used
    bot.sendMessage(msg.chat.id,'unmuted');
  });

  // /autoremove on|off toggles automatic deletion of triggered alerts
  bot.onText(/\/autoremove\s+(on|off)/, (msg, match) => {
    const flag = match[1] === 'on';
    db.setAutoRemove(msg.chat.id, flag);
    bot.sendMessage(msg.chat.id, `autoremove ${flag ? 'enabled' : 'disabled'}`);
  });

  // /risk size pct pts - record risk parameters for the user
  bot.onText(/\/risk\s+(\S+)\s+(\S+)\s+(\S+)/, (msg, match) => {
    const size = parseFloat(match[1]);
    const pct = parseFloat(match[2]);
    const pts = parseFloat(match[3]);
    if ([size, pct, pts].some(x => Number.isNaN(x)))
      return bot.sendMessage(msg.chat.id,'invalid risk parameters');
    db.setRiskParams(msg.chat.id, size, pct, pts);
    bot.sendMessage(msg.chat.id, `risk params set (size=${size}, pct=${pct}, pts=${pts})`);
  });

  bot.onText(/\/status/, (msg) => {
    const u = db.getUser(msg.chat.id) || {};
    const cooldown = u.default_cooldown != null ? u.default_cooldown : process.env.DEFAULT_ALERT_COOLDOWN || 'unset';
    const autoremove = u.autoremove ? 'on' : 'off';
    const risk = (u.risk_size != null)
      ? `size=${u.risk_size} pct=${u.risk_percent} pts=${u.risk_points}`
      : 'none';
    const text = `Settings:
Default cooldown: ${cooldown}
Alerts enabled: ${u.alerts_enabled ? 'yes' : 'no'}
Autoremove: ${autoremove}
Risk: ${risk}`;
    bot.sendMessage(msg.chat.id, text);
  });
}

module.exports = registerCommands;