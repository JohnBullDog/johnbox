/**
 * BaseGame — extend this to build new game types.
 *
 * Subclasses must implement:
 *   start(players)
 *   handlePlayerAction(player, data)
 *   advance()            — called when host presses "skip/next"
 *
 * Convenience helpers:
 *   broadcast(event, data)         → all sockets in the room channel
 *   send(socketId, event, data)    → one socket
 *   startTimer(secs, cb)           → emits 'timer' every second, calls cb at 0
 *   clearTimer()
 *
 * Reliable delivery for player:phase:
 *   Every player:phase emission is tagged with a _msgId and retried every
 *   RETRY_MS until the client sends back phase:ack { msgId }.
 *   Call ackPlayerPhase(socketId, msgId) when the ack arrives.
 *   Call clearPlayerAck(socketId) when the socket remaps (reconnect).
 *   Call destroy() when the room closes to stop all retry timers.
 */

const RETRY_MS = 2000;

class BaseGame {
  constructor(roomCode, io) {
    this.roomCode = roomCode;
    this.io = io;
    this.players = [];
    this.phase = 'idle';
    this._timer = null;
    this.timeLeft = 0;
    this._msgSeq = 0;
    this._pendingAcks = new Map();  // socketId → { msgId, retryTimer }
  }

  get channel() { return `room:${this.roomCode}`; }

  broadcast(event, data) { this.io.to(this.channel).emit(event, data); }

  send(socketId, event, data) {
    if (event === 'player:phase') {
      const p = this.players.find(pl => pl.id === socketId);
      if (p) p._lastPhase = data;

      const msgId = ++this._msgSeq;
      const payload = { ...data, _msgId: msgId };

      this._clearAck(socketId);
      this.io.to(socketId).emit('player:phase', payload);
      const retryTimer = setInterval(() => {
        this.io.to(socketId).emit('player:phase', payload);
      }, RETRY_MS);
      this._pendingAcks.set(socketId, { msgId, retryTimer });
      return;
    }
    this.io.to(socketId).emit(event, data);
  }

  // Called when the client sends phase:ack { msgId }.
  ackPlayerPhase(socketId, msgId) {
    const pending = this._pendingAcks.get(socketId);
    if (pending?.msgId === msgId) this._clearAck(socketId);
  }

  // Cancel pending retry for a socket (used on reconnect before syncPlayer).
  clearPlayerAck(socketId) { this._clearAck(socketId); }

  // Re-send the last player:phase to a reconnecting player.
  // Stamps the current server-side timeLeft so the player's timer is accurate.
  syncPlayer(player) {
    // game.players are shallow copies (created in start()); _lastPhase lives there.
    // Look up by ID to get the copy that actually has _lastPhase set.
    const gamePlayer = this.players.find(p => p.id === player.id) ?? player;
    if (!gamePlayer._lastPhase) return;
    const phase = this.timeLeft > 0
      ? { ...gamePlayer._lastPhase, timeLeft: this.timeLeft }
      : gamePlayer._lastPhase;
    this.send(player.id, 'player:phase', phase);
  }

  // Remap player-ID keyed state after a reconnect changes the socket ID.
  // Base implementation updates the game's own player list; subclasses call
  // super() then remap any Maps/Sets they keep keyed by player ID.
  updatePlayerId(oldId, newId) {
    const p = this.players.find(pl => pl.id === oldId);
    if (p) p.id = newId;
  }

  // Stop all retry timers — call when the room is destroyed.
  destroy() {
    this.clearTimer();
    for (const { retryTimer } of this._pendingAcks.values()) clearInterval(retryTimer);
    this._pendingAcks.clear();
  }

  _clearAck(socketId) {
    const p = this._pendingAcks.get(socketId);
    if (p) { clearInterval(p.retryTimer); this._pendingAcks.delete(socketId); }
  }

  startTimer(seconds, callback) {
    this.clearTimer();
    this.timeLeft = seconds;
    this.broadcast('timer', { timeLeft: seconds });

    const tick = () => {
      this.timeLeft--;
      this.broadcast('timer', { timeLeft: this.timeLeft });
      if (this.timeLeft <= 0) {
        callback();
      } else {
        this._timer = setTimeout(tick, 1000);
      }
    };
    this._timer = setTimeout(tick, 1000);
  }

  clearTimer() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  start(players)                    { throw new Error('start() not implemented'); }
  handlePlayerAction(player, data)  { throw new Error('handlePlayerAction() not implemented'); }
  advance()                         {}
}

module.exports = BaseGame;
