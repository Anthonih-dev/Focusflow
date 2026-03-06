# FocusFlow

Telegram trading assistant that subscribes to Deriv ticks and sends per-user alerts.

Quick start:
1. Copy `.env.example` to `.env` and set `BOT_TOKEN`.
2. npm install
3. npm start

Simulator:
- Run `npm run simulate` to start a local mock Deriv WebSocket server (change DERIV_WS_URL to ws://localhost:8080).

Commands are now much richer:

```
/set SYMBOL PRICE [above|below]
/zone SYMBOL LOW HIGH
/spike SYMBOL THRESHOLD [WINDOW_SECONDS]
/volspike SYMBOL THRESHOLD_PERCENT [WINDOW_SECONDS]
/list
/delete ALERT_ID
/clear SYMBOL
/mute
/unmute
/autoremove on|off   - auto‑delete triggered alerts
/risk size pct pts     - record risk parameters
/status
```