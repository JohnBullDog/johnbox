const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const RoomManager = require('./RoomManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

const roomManager = new RoomManager(io);

// Detect public URL: prefer explicit env var, then probe ngrok's local API
let publicUrl = process.env.PUBLIC_URL || null;

async function detectNgrokUrl() {
  try {
    const res  = await fetch('http://localhost:4040/api/tunnels');
    const data = await res.json();
    const tunnel = data.tunnels?.find(t => t.proto === 'https') ?? data.tunnels?.[0];
    if (tunnel?.public_url) {
      publicUrl = tunnel.public_url;
      console.log(`  Public   : ${publicUrl}`);
    }
  } catch {
    // ngrok not running — fall back to request origin on the client
  }
}

app.use(express.static(path.join(__dirname, '../public')));

// Clients call this to get the public base URL for QR codes / share links
app.get('/api/public-url', (req, res) => {
  res.json({ url: publicUrl });
});

// Host/TV screen
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/host/index.html'));
});

// Player controller
app.get('/play', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/player/index.html'));
});

io.on('connection', (socket) => {
  console.log(`[+] socket ${socket.id}`);

  socket.on('room:create',  (data) => roomManager.createRoom(socket, data));
  socket.on('room:join',    (data) => roomManager.joinRoom(socket, data));
  socket.on('game:start',   (data) => roomManager.startGame(socket, data));
  socket.on('game:next',    ()     => roomManager.advanceGame(socket));
  socket.on('game:action',  (data) => roomManager.handleAction(socket, data));
  socket.on('disconnect',   ()     => roomManager.handleDisconnect(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', async () => {
  const ifaces = require('os').networkInterfaces();
  const lan = Object.values(ifaces).flat().find(i => i.family === 'IPv4' && !i.internal);
  console.log(`\nJohnBox running`);
  console.log(`  Host/TV  : http://localhost:${PORT}`);
  console.log(`  LAN      : http://${lan?.address ?? 'YOUR_LAN_IP'}:${PORT}/play`);
  await detectNgrokUrl();
  console.log();
});
