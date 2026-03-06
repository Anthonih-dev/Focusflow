// Local simulator that acts like Deriv WebSocket and emits tick messages.
// Usage: set DERIV_WS_URL=ws://localhost:8080 in .env and run `npm run simulate`
// This script creates a WS server that sends ticks every second for configured symbols.

const WebSocket = require('ws');

const PORT = process.env.SIM_PORT || 8080;
const server = new WebSocket.Server({ port: PORT });

const symbols = (process.env.SIM_SYMBOLS || 'R_100').split(',');
console.log(`Simulator running on ws://localhost:${PORT} sending symbols: ${symbols.join(',')}`);

function randomWalk(base = 100, spread = 1) {
  let price = base;
  return () => {
    price += (Math.random() - 0.5) * spread;
    return Number(price.toFixed(2));
  };
}

const generators = {};
symbols.forEach(s => generators[s] = randomWalk(100 + Math.random() * 100, 1.5));

server.on('connection', (ws) => {
  console.log('Client connected to simulator');
  const interval = setInterval(() => {
    for (const sym of symbols) {
      const price = generators[sym]();
      const msg = JSON.stringify({ tick: { symbol: sym, quote: String(price) } });
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }, 1000);

  ws.on('close', () => clearInterval(interval));
});

server.on('listening', () => console.log('Simulator ready.'));