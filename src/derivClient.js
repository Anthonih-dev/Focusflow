const WebSocket = require('ws');

class DerivStream {
  constructor({ appId, onTick, onStatus }) {
    this.appId = appId;
    this.onTick = onTick;
    this.onStatus = onStatus;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.isClosing = false;
    this.symbolToReq = new Map();
    this.reqToSymbol = new Map();
  }

  connect() {
    const url = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.onStatus?.('connected');
      for (const symbol of this.symbolToReq.keys()) {
        this._sendSubscribe(symbol);
      }
    });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.error) {
          this.onStatus?.(`error:${msg.error.message}`);
          return;
        }

        if (msg.msg_type === 'tick' && msg.tick) {
          const symbol = msg.tick.symbol || this.reqToSymbol.get(msg.subscription?.id);
          if (!symbol) return;
          this.onTick?.({
            symbol,
            price: Number(msg.tick.quote),
            epoch: msg.tick.epoch,
            id: msg.subscription?.id
          });
        }

        if (msg.msg_type === 'tick' && msg.subscription?.id && msg.echo_req?.ticks) {
          const symbol = msg.echo_req.ticks;
          this.reqToSymbol.set(msg.subscription.id, symbol);
          this.symbolToReq.set(symbol, msg.subscription.id);
        }
      } catch (err) {
        this.onStatus?.(`parse_error:${err.message}`);
      }
    });

    this.ws.on('close', () => {
      this.onStatus?.('disconnected');
      if (!this.isClosing) this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this.onStatus?.(`socket_error:${err.message}`);
    });
  }

  ensureSymbol(symbol) {
    if (this.symbolToReq.has(symbol)) return;
    this.symbolToReq.set(symbol, null);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this._sendSubscribe(symbol);
    }
  }

  removeSymbol(symbol) {
    const subId = this.symbolToReq.get(symbol);
    if (subId && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ forget: subId }));
    }
    this.symbolToReq.delete(symbol);
    if (subId) this.reqToSymbol.delete(subId);
  }

  _sendSubscribe(symbol) {
    this.ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
  }

  _scheduleReconnect() {
    this.reconnectAttempts += 1;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.reconnectAttempts, 5));
    setTimeout(() => {
      if (!this.isClosing) this.connect();
    }, delay);
  }

  close() {
    this.isClosing = true;
    if (this.ws) this.ws.close();
  }
}

module.exports = { DerivStream };
