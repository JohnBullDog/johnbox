/**
 * SketchMatch — a Drawful-style game that exercises all three input modes.
 *
 * Input types used per phase:
 *   drawing  → DRAW   (canvas strokes, synced live to host screen)
 *   guessing → TYPE   (text input — what do you think they drew?)
 *   voting   → SELECT (tap an answer from a shuffled list)
 *
 * Phase flow (per round):
 *   round_intro → drawing → guessing → voting → round_results → [repeat or game_over]
 *
 * Scoring:
 *   Correct vote (picked the real word)    +200 pts
 *   Drawer gets per correct voter          +50 pts
 *   Your fake answer fools someone         +100 pts per fool
 */

const BaseGame = require('./BaseGame');

const PROMPTS = [
  'bicycle', 'elephant', 'pizza', 'rainbow', 'submarine',
  'volcano', 'superhero', 'spaceship', 'jellyfish', 'tornado',
  'lighthouse', 'dragon', 'popcorn', 'guitar', 'snowman',
  'umbrella', 'castle', 'pirate', 'robot', 'mermaid',
  'sandwich', 'telescope', 'butterfly', 'skateboard', 'campfire',
  'dinosaur', 'treasure map', 'hot air balloon', 'firefighter', 'cactus',
  'spaghetti', 'trampoline', 'penguin', 'wizard', 'rollercoaster',
  'waterfall', 'kangaroo', 'volcano eruption', 'haunted house', 'lollipop',
];

const T_INTRO    = 5;
const T_DRAWING  = 90;
const T_GUESSING = 60;
const T_VOTING   = 30;
const T_RESULTS  = 10;

class SketchMatch extends BaseGame {
  constructor(roomCode, io) {
    super(roomCode, io);
    this.maxRounds   = 3;
    this.round       = 0;
    this.drawerIndex = 0;
    this.prompt      = null;
    this.guesses     = new Map();  // playerId → text
    this.votes       = new Map();  // playerId → answer text
    this.answers     = [];         // shuffled list shown during voting
    this.usedPrompts = new Set();
  }

  // ── Lifecycle ──────────────────────────────────────────────

  start(players) {
    this.players     = players.map(p => ({ ...p, score: 0 }));
    this.drawerIndex = 0;
    this.round       = 0;
    this._beginRound();
  }

  advance() {
    this.clearTimer();
    switch (this.phase) {
      case 'round_intro':   this._beginDrawing(); break;
      case 'drawing':       this._beginGuessing(); break;
      case 'guessing':      this._beginVoting(); break;
      case 'voting':        this._showResults(); break;
      case 'round_results': this._nextRound(); break;
    }
  }

  handlePlayerAction(player, data) {
    const drawer = this._drawer();
    switch (data.type) {

      // ── Live drawing strokes → forwarded to host canvas ───
      case 'draw_event':
        if (this.phase === 'drawing' && player.id === drawer.id) {
          this.broadcast('host:draw', { event: data.event });
        }
        break;

      // ── Drawer signals they're done ───────────────────────
      case 'submit_drawing':
        if (this.phase === 'drawing' && player.id === drawer.id) {
          this.clearTimer();
          this._beginGuessing();
        }
        break;

      // ── Non-drawer submits a text guess ───────────────────
      case 'submit_guess':
        if (this.phase !== 'guessing') break;
        if (player.id === drawer.id)  break;
        if (this.guesses.has(player.id)) break;
        {
          const text = (data.text ?? '').trim().slice(0, 100);
          if (!text) break;
          this.guesses.set(player.id, text);
          this.send(player.id, 'player:phase', { phase: 'guessing', role: 'waiting', guess: text });
          const total = this.players.length - 1;
          this.broadcast('host:guesses_up', { guessesIn: this.guesses.size, total });
          if (this.guesses.size >= total) { this.clearTimer(); this._beginVoting(); }
        }
        break;

      // ── Player votes for an answer ────────────────────────
      case 'submit_vote':
        if (this.phase !== 'voting') break;
        if (this.votes.has(player.id)) break;
        {
          const answer = (data.answer ?? '').trim();
          if (!this.answers.includes(answer)) break;
          this.votes.set(player.id, answer);
          this.send(player.id, 'player:phase', { phase: 'voting', role: 'waiting', voted: answer });
          this.broadcast('host:votes_up', { votesIn: this.votes.size, total: this.players.length });
          if (this.votes.size >= this.players.length) { this.clearTimer(); this._showResults(); }
        }
        break;
    }
  }

  // ── Phase transitions ──────────────────────────────────────

  _beginRound() {
    this.round++;
    this.guesses.clear();
    this.votes.clear();
    this.answers = [];
    this.prompt  = this._pickPrompt();
    this.phase   = 'round_intro';

    const drawer = this._drawer();

    this.broadcast('host:phase', {
      phase: 'round_intro',
      round: this.round, maxRounds: this.maxRounds,
      drawerName: drawer.name, drawerColor: drawer.color,
    });

    this.players.forEach(p => {
      this.send(p.id, 'player:phase', {
        phase: 'round_intro',
        round: this.round, maxRounds: this.maxRounds,
        drawerName: drawer.name,
        isDrawer: p.id === drawer.id,
      });
    });

    this.startTimer(T_INTRO, () => this._beginDrawing());
  }

  _beginDrawing() {
    this.phase = 'drawing';
    const drawer = this._drawer();

    this.broadcast('host:phase', {
      phase: 'drawing',
      round: this.round, maxRounds: this.maxRounds,
      drawerName: drawer.name, drawerColor: drawer.color,
      timeLeft: T_DRAWING,
    });

    this.players.forEach(p => {
      if (p.id === drawer.id) {
        this.send(p.id, 'player:phase', {
          phase: 'drawing', role: 'drawer',
          prompt: this.prompt, timeLeft: T_DRAWING,
        });
      } else {
        this.send(p.id, 'player:phase', {
          phase: 'drawing', role: 'watcher',
          drawerName: drawer.name,
        });
      }
    });

    this.startTimer(T_DRAWING, () => this._beginGuessing());
  }

  _beginGuessing() {
    this.phase = 'guessing';
    const drawer = this._drawer();

    this.broadcast('host:phase', {
      phase: 'guessing',
      drawerName: drawer.name,
      timeLeft: T_GUESSING,
      total: this.players.length - 1,
      guessesIn: this.guesses.size,
    });

    this.players.forEach(p => {
      if (p.id === drawer.id) {
        this.send(p.id, 'player:phase', {
          phase: 'guessing', role: 'drawer', prompt: this.prompt,
        });
      } else if (this.guesses.has(p.id)) {
        this.send(p.id, 'player:phase', {
          phase: 'guessing', role: 'waiting', guess: this.guesses.get(p.id),
        });
      } else {
        this.send(p.id, 'player:phase', {
          phase: 'guessing', role: 'guesser', timeLeft: T_GUESSING,
        });
      }
    });

    this.startTimer(T_GUESSING, () => this._beginVoting());
  }

  _beginVoting() {
    this.phase = 'voting';
    this.clearTimer();

    // Real word + submitted fakes, deduplicated, shuffled
    const fakes = [...new Set([...this.guesses.values()])];
    const pool  = [this.prompt, ...fakes.filter(f => f.toLowerCase() !== this.prompt.toLowerCase())];
    this.answers = pool.sort(() => Math.random() - 0.5);

    this.broadcast('host:phase', {
      phase: 'voting',
      answers: this.answers,
      timeLeft: T_VOTING,
      total: this.players.length,
      votesIn: 0,
    });

    this.players.forEach(p => {
      this.send(p.id, 'player:phase', {
        phase: 'voting',
        answers: this.answers,
        myGuess: this.guesses.get(p.id) ?? null,
        timeLeft: T_VOTING,
      });
    });

    this.startTimer(T_VOTING, () => this._showResults());
  }

  _showResults() {
    this.phase = 'round_results';
    this.clearTimer();

    const drawer = this._drawer();
    const deltas = new Map(this.players.map(p => [p.id, 0]));

    // Correct guessers
    this.votes.forEach((answer, voterId) => {
      if (answer.toLowerCase() === this.prompt.toLowerCase()) {
        const voter = this._findPlayer(voterId);
        if (voter && voter.id !== drawer.id) {
          deltas.set(voterId, deltas.get(voterId) + 200);
          deltas.set(drawer.id, deltas.get(drawer.id) + 50);
        }
      }
    });

    // Fools (someone voted for your fake)
    this.guesses.forEach((guessText, guesserId) => {
      this.votes.forEach((votedAnswer, voterId) => {
        if (votedAnswer === guessText && voterId !== guesserId) {
          deltas.set(guesserId, deltas.get(guesserId) + 100);
        }
      });
    });

    this.players.forEach(p => { p.score += deltas.get(p.id) ?? 0; });

    // Build rich detail for the reveal
    const answerDetails = this.answers.map(ans => {
      const isReal = ans.toLowerCase() === this.prompt.toLowerCase();
      const submitter = !isReal
        ? this._findPlayer([...this.guesses.entries()].find(([, t]) => t === ans)?.[0])
        : null;
      const voters = [...this.votes.entries()]
        .filter(([, a]) => a === ans)
        .map(([id]) => this._findPlayer(id)?.name)
        .filter(Boolean);
      return { ans, isReal, submitterName: submitter?.name ?? null, voters };
    });

    const payload = {
      phase: 'round_results',
      realPrompt: this.prompt,
      drawerName: drawer.name,
      answerDetails,
      players: this.players.map(p => ({
        id: p.id, name: p.name, score: p.score, color: p.color,
        delta: deltas.get(p.id) ?? 0,
      })),
    };

    this.broadcast('host:phase', payload);
    this.players.forEach(p => {
      this.send(p.id, 'player:phase', { ...payload, myDelta: deltas.get(p.id) ?? 0 });
    });

    this.startTimer(T_RESULTS, () => this._nextRound());
  }

  _nextRound() {
    this.drawerIndex++;
    if (this.round >= this.maxRounds) {
      this._endGame();
    } else {
      this._beginRound();
    }
  }

  _endGame() {
    this.phase = 'game_over';
    this.clearTimer();

    const sorted = [...this.players].sort((a, b) => b.score - a.score);
    const payload = {
      phase: 'game_over',
      players: sorted.map((p, i) => ({ ...p, rank: i + 1 })),
    };

    this.broadcast('host:phase', payload);
    this.players.forEach(p => {
      this.send(p.id, 'player:phase', {
        ...payload,
        myRank: sorted.findIndex(s => s.id === p.id) + 1,
      });
    });
  }

  // ── Utilities ──────────────────────────────────────────────

  _drawer() { return this.players[this.drawerIndex % this.players.length]; }

  _findPlayer(id) { return this.players.find(p => p.id === id) ?? null; }

  _pickPrompt() {
    const pool = PROMPTS.filter(p => !this.usedPrompts.has(p));
    const list = pool.length > 0 ? pool : PROMPTS;
    const pick = list[Math.floor(Math.random() * list.length)];
    this.usedPrompts.add(pick);
    return pick;
  }
}

module.exports = SketchMatch;
