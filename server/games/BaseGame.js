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
 */
class BaseGame {
  constructor(roomCode, io) {
    this.roomCode = roomCode;
    this.io = io;
    this.players = [];
    this.phase = 'idle';
    this._timer = null;
    this.timeLeft = 0;
  }

  get channel() { return `room:${this.roomCode}`; }

  broadcast(event, data)           { this.io.to(this.channel).emit(event, data); }
  send(socketId, event, data)      { this.io.to(socketId).emit(event, data); }

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
