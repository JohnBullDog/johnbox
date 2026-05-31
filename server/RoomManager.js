/**
 * RoomManager — creates rooms, routes socket events to the right game instance.
 *
 * Room lifecycle:
 *   host creates room  →  players join  →  host starts game  →  game handles everything
 *
 * Socket event contracts
 * ─────────────────────────────────────────────────────────────
 * CLIENT → SERVER
 *   room:create   { gameType? }
 *   room:join     { code, playerName }
 *   game:start    (host only)
 *   game:next     (host only — skip/advance current phase)
 *   game:action   { type, ...payload }   — forwarded to the active game
 *
 * SERVER → CLIENT (host screen)
 *   room:created      { code }
 *   lobby:update      { players }
 *   host:phase        { phase, ...data }
 *   host:draw         { event }          — live drawing strokes
 *   host:guesses_up   { guessesIn, total }
 *   host:votes_up     { votesIn, total }
 *   timer             { timeLeft }
 *   error             { message }
 *   room:closed       { message }
 *
 * SERVER → CLIENT (player controller)
 *   room:joined       { code, player }
 *   lobby:update      { players }
 *   player:phase      { phase, role, ...data }
 *   timer             { timeLeft }
 *   error             { message }
 *   room:closed       { message }
 */

const crypto      = require('crypto');
const SketchMatch = require('./games/SketchMatch');
const TagGame     = require('./games/TagGame');
const GslsGame    = require('./games/GslsGame');

const GAMES = {
  'sketch-match': SketchMatch,
  'tag-out':      TagGame,
  'gsls':         GslsGame,
};

const PLAYER_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
  '#FFA07A', '#87CEEB', '#FFB6C1', '#90EE90',
];

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();           // code → room
    this.socketToRoom = new Map();    // socketId → code
    this.sessionToCode = new Map();   // sessionToken → roomCode
    this._colorIndex = 0;
  }

  // ── Public handlers ────────────────────────────────────────

  createRoom(socket, { gameType = 'sketch-match' } = {}) {
    const GameClass = GAMES[gameType] ?? SketchMatch;
    const code = this._genCode();

    const room = {
      code,
      hostId: socket.id,
      gameType,
      game: new GameClass(code, this.io),
      players: new Map(),   // socketId → player object
      state: 'lobby',
    };

    this.rooms.set(code, room);
    this.socketToRoom.set(socket.id, code);
    socket.join(this._chan(code));

    socket.emit('room:created', { code });
    console.log(`[room] created ${code} (${gameType})`);
  }

  joinRoom(socket, { code, playerName } = {}) {
    code = (code ?? '').toUpperCase().trim();
    const room = this.rooms.get(code);

    if (!room)                     return socket.emit('error', { message: 'Room not found. Check your code.' });
    if (room.state !== 'lobby')    return socket.emit('error', { message: 'Game already in progress.' });
    if (!playerName?.trim())       return socket.emit('error', { message: 'Enter a name to join.' });

    const name = playerName.trim().slice(0, 20);
    const taken = [...room.players.values()].some(p => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return socket.emit('error', { message: `"${name}" is already taken.` });

    const sessionToken = crypto.randomUUID();
    const player = {
      id: socket.id,
      name,
      score: 0,
      color: PLAYER_COLORS[this._colorIndex++ % PLAYER_COLORS.length],
      sessionToken,
    };

    room.players.set(socket.id, player);
    this.socketToRoom.set(socket.id, code);
    this.sessionToCode.set(sessionToken, code);
    socket.join(this._chan(code));

    socket.emit('room:joined', { code, player });
    this._broadcastLobby(room);
    console.log(`[room] ${name} joined ${code}`);
  }

  startGame(socket, data = {}) {
    const room = this._hostRoom(socket);
    if (!room) return;
    if (room.players.size < 2) return socket.emit('error', { message: 'Need at least 2 players to start.' });

    room.state = 'playing';
    const options = { rounds: Math.max(1, Math.min(10, parseInt(data.rounds) || 3)) };
    room.game.start([...room.players.values()], options);
    console.log(`[room] ${room.code} game started (rounds: ${options.rounds})`);
  }

  handleAction(socket, data = {}) {
    const room = this.rooms.get(this.socketToRoom.get(socket.id));
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    room.game.handlePlayerAction(player, data);
  }

  handlePhaseAck(socket, { msgId } = {}) {
    const room = this.rooms.get(this.socketToRoom.get(socket.id));
    if (!room || room.state !== 'playing') return;
    room.game.ackPlayerPhase(socket.id, msgId);
  }

  advanceGame(socket) {
    const room = this._hostRoom(socket);
    if (!room) return;
    room.game.advance();
  }

  handleDisconnect(socket) {
    const code = this.socketToRoom.get(socket.id);
    if (!code) return;
    this.socketToRoom.delete(socket.id);

    const room = this.rooms.get(code);
    if (!room) return;

    if (socket.id === room.hostId) {
      // Clean up all player sessions then close the room
      for (const p of room.players.values()) this.sessionToCode.delete(p.sessionToken);
      if (room.game) room.game.destroy();
      this.io.to(this._chan(code)).emit('room:closed', { message: 'The host disconnected.' });
      this.rooms.delete(code);
      console.log(`[room] ${code} closed (host left)`);
    } else {
      // Keep the player in the room so they can reconnect via session token.
      // Just unmap the socket; the player object remains in room.players.
      const p = room.players.get(socket.id);
      console.log(`[room] ${p?.name ?? socket.id} disconnected from ${code} (can rejoin)`);
    }
  }

  rejoinRoom(socket, { sessionToken } = {}) {
    const code = this.sessionToCode.get(sessionToken);
    if (!code) return socket.emit('error', { message: 'Session expired. Please join again.' });

    const room = this.rooms.get(code);
    if (!room) {
      this.sessionToCode.delete(sessionToken);
      return socket.emit('error', { message: 'Room no longer exists.' });
    }

    // Find player by session token in current room.players
    let player = null;
    let oldSocketId = null;
    for (const [sid, p] of room.players) {
      if (p.sessionToken === sessionToken) { player = p; oldSocketId = sid; break; }
    }
    if (!player) return socket.emit('error', { message: 'Player not found. Please rejoin.' });

    // Remap socket ID
    const newSocketId = socket.id;
    if (oldSocketId !== newSocketId) {
      room.players.delete(oldSocketId);
      this.socketToRoom.delete(oldSocketId);
      player.id = newSocketId;
      room.players.set(newSocketId, player);
      if (room.state === 'playing') {
        room.game.clearPlayerAck(oldSocketId);  // cancel retry on old socket
        room.game.updatePlayerId(oldSocketId, newSocketId);
      }
    }
    this.socketToRoom.set(newSocketId, code);
    socket.join(this._chan(code));

    socket.emit('room:rejoined', { code, player, state: room.state });

    if (room.state === 'playing') {
      room.game.syncPlayer(player);
    } else {
      this._broadcastLobby(room);
    }
    console.log(`[room] ${player.name} reconnected to ${code}`);
  }

  // ── Helpers ────────────────────────────────────────────────

  _broadcastLobby(room) {
    this.io.to(this._chan(room.code)).emit('lobby:update', {
      players: [...room.players.values()],
    });
  }

  _hostRoom(socket) {
    const room = this.rooms.get(this.socketToRoom.get(socket.id));
    if (!room || room.hostId !== socket.id) {
      socket.emit('error', { message: 'Not authorized.' });
      return null;
    }
    return room;
  }

  _chan(code) { return `room:${code}`; }

  _genCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code;
    do {
      code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (this.rooms.has(code));
    return code;
  }
}

module.exports = RoomManager;
