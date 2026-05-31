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

app.use(express.static(path.join(__dirname, '../public')));

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
  socket.on('game:start',   ()     => roomManager.startGame(socket));
  socket.on('game:next',    ()     => roomManager.advanceGame(socket));
  socket.on('game:action',  (data) => roomManager.handleAction(socket, data));
  socket.on('disconnect',   ()     => roomManager.handleDisconnect(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const ifaces = require('os').networkInterfaces();
  const lan = Object.values(ifaces).flat().find(i => i.family === 'IPv4' && !i.internal);
  console.log(`\nJohnBox running`);
  console.log(`  Host/TV  : http://localhost:${PORT}`);
  console.log(`  Players  : http://${lan?.address ?? 'YOUR_LAN_IP'}:${PORT}/play`);
  console.log();
});
