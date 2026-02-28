# Deriv Synthetic Indices Telegram Alert Bot

Node.js Telegram bot that streams real-time ticks from Deriv WebSocket API and triggers user-specific alerts.

## Features

- Live synthetic index monitoring (e.g., `V75`, `Boom1000`, `Crash500`, `StepIndex`)
- Alert types:
  - Price touch (`/set V75 350000`)
  - Breakout above/below (`/set Boom1000 12345 above`)
  - Zone entry (`/zone Crash500 950 1000`)
  - Spike detection (`/spike Boom1000 25 5`)
  - Volatility spike (`/volspike V75 0.8 10`)
- SQLite persistence for users and alerts
- Multi-user isolation by Telegram user ID
- Alert management commands: `/list`, `/delete`, `/clear`, `/mute`, `/unmute`
- Auto-remove toggle (`/autoremove on|off`)
- Risk calculator (`/risk account_size risk_percent stop_loss_points`)
- Deriv WebSocket reconnect and symbol subscription management

## Setup

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env
# set TELEGRAM_BOT_TOKEN and optional DERIV_APP_ID / DB_PATH
```

3. Start bot:

```bash
npm start
```

## Deployment (VPS/Cloud)

Use PM2 or systemd for production:

```bash
npm install -g pm2
pm2 start src/index.js --name deriv-alert-bot
pm2 save
```

## Command Reference

- `/start`
- `/set SYMBOL PRICE [above|below]`
- `/zone SYMBOL LOW HIGH`
- `/spike SYMBOL THRESHOLD [WINDOW_SECONDS]`
- `/volspike SYMBOL THRESHOLD_PERCENT [WINDOW_SECONDS]`
- `/list`
- `/delete ALERT_ID`
- `/clear SYMBOL`
- `/mute`
- `/unmute`
- `/autoremove on|off`
- `/risk account_size risk_percent stop_loss_points`

## Notes

- Symbols are normalized (e.g., `V75 -> R_75`, `STEP -> STEPINDEX`).
- Alerts are checked on each tick and notifications are sent instantly.
- Auto-remove is enabled by default and can be turned off.
