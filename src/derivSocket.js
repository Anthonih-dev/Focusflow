const WebSocket = require('ws');
const EventEmitter = require('events');

class DerivSocket extends EventEmitter {
  constructor({ url } = {}) {
    super();
    this.url = url || process.env.DERIV_WS_URL || 'wss://ws.derivws.com';
    this.ws = null;
    this.subscriptions = new Set();
    this._connected = false;
    this._reconnectAttempts = 0;
    this._maxBackoff = 30000;
    this._connect();
  }

  _connect() {
    this.ws = new WebSocket(this.url);
    this.ws.on('open', () => {
      this._connected = true;
      this._reconnectAttempts = 0;
      this.emit('open');
      for (const s of this.subscriptions) {
        this._sendSubscribe(s);
      }
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.tick && msg.tick.quote) {
          const { symbol, quote } = msg.tick;
          const price = Number(quote);
          this.emit('tick', symbol, price, msg.tick);
        }
      } catch (err) {
        this.emit('error', err);
      }
    });

    this.ws.on('close', (code, reason) => {
      this._connected = false;
      this.emit('close', code, reason);
      this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this.emit('error', err);
    });
  }

  _scheduleReconnect() {
    this._reconnectAttempts++;
    const backoff = Math.min(1000 * 2 ** (this._reconnectAttempts - 1), this._maxBackoff);
    setTimeout(() => this._connect(), backoff);
  }

  _sendSubscribe(symbol) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const req = { ticks: String(symbol) };
    try { this.ws.send(JSON.stringify(req)); } catch (e) { /* ignore */ }
  }

  subscribe(symbol) {
    symbol = String(symbol);
    if (this.subscriptions.has(symbol)) return;
    this.subscriptions.add(symbol);
    if (this._connected) this._sendSubscribe(symbol);
  }

  unsubscribe(symbol) {
    symbol = String(symbol);
    if (!this.subscriptions.has(symbol)) return;
    this.subscriptions.delete(symbol);
    if (this._connected) {
      const req = { forget: symbol };
      try { this.ws.send(JSON.stringify(req)); } catch (e) {}
    }
  }

  close() {
    try { this.ws && this.ws.close(); } catch (e) {}
  }
}

module.exports = DerivSocket;