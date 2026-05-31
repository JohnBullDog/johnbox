/**
 * TagGame — "Tag You're Out"
 *
 * Flow per turn:
 *   spin_ready → spinning → adj_result | event_result → [event_resolve] →
 *   task_intro → skit → performance_vote → skit_result → [next turn or game_over]
 *
 * Performer cap: never more than floor(playerCount/2), max 4.
 * Tags: unlimited — each spin/event adds to the player's tag array.
 *
 * Scoring:
 *   Performance rating (1–10 vote by non-performers) → avg × 25 pts
 *   Failed tag penalty                                → −100 pts each
 *   Immunity bonus (if immune)                        → +50 pts flat
 *   Successful callout contribution                   → +30 pts per voter
 *
 * Input types:
 *   spin_ready       → player taps SPIN        (type: 'spin')
 *   event_resolve    → pick target/adjective   (type: 'event_choice' | 'event_choose_tag' | 'audience_vote')
 *   skit             → tap tags                (type: 'callout_tag', targetId, tag)
 *   performance_vote → rate 1-10               (type: 'performance_vote', rating: number)
 *
 * Data files (add new entries to extend content):
 *   data/adjectives.json  — wheel adjective slots
 *   data/events.json      — event spaces
 *   data/tasks.json       — skit prompts
 *
 * Wheel layout: 24 segments — every 6th slot is an event, rest are adjectives.
 * Wheel is fixed for the whole game session and sent to all clients once.
 */

const BaseGame   = require('./BaseGame');
const adjectives = require('../../data/adjectives.json');
const events     = require('../../data/events.json');
const tasks      = require('../../data/tasks.json');

function _transferMapKey(map, oldKey, newKey) {
  if (map.has(oldKey)) { map.set(newKey, map.get(oldKey)); map.delete(oldKey); }
}

const T_SPIN_RESULT        = 5;
const T_ADJ_RESULT         = 4;
const T_EVENT_RESULT       = 5;
const T_EVENT_RESOLVE_AUTO = 30;
const T_TASK_INTRO         = 6;
const T_SKIT               = 120;
const T_PERF_VOTE          = 20;   // seconds for performance rating
const T_SKIT_RESULT        = 10;
const WHEEL_SEGMENTS       = 16;

const SCORE_PER_RATING_POINT = 25;   // avg rating 1-10 → ×25 pts
const FAILED_TAG_PENALTY     = 100;  // per failed tag
const IMMUNITY_BONUS         = 50;   // flat bonus if immune this turn
const CALLOUT_REWARD         = 30;   // per voter who contributed to a majority

class TagGame extends BaseGame {
  constructor(roomCode, io) {
    super(roomCode, io);

    this.wheelSegments = this._buildWheel();
    this.playerOrder   = [];
    this.turnIdx       = 0;

    // Per-skit state
    this.currentPerformers = [];
    this.currentTask       = null;
    // callouts: Map<`${performerId}:${tag}`, Set<voterId>>
    this.callouts    = new Map();
    this.failedTags  = new Set();   // keys that reached majority

    // Event resolution state
    this.pendingEvent  = null;
    this.audienceVotes = new Map(); // playerId → suggested adjective

    // Performance vote state (set during performance_vote phase)
    this.performanceVotes = new Map(); // voterId → rating 1-10
  }

  // ── Lifecycle ──────────────────────────────────────────────

  start(players, options = {}) {
    this.maxRounds = Math.max(1, options.rounds ?? 3);
    this.players   = players.map(p => ({ ...p, score: 0, tags: [], immune: false }));

    // Build full turn order: each round shuffled independently
    this.playerOrder = [];
    for (let r = 0; r < this.maxRounds; r++) {
      this.playerOrder.push(...this._shuffle([...this.players]));
    }
    this.turnIdx = 0;
    this._beginSpinReady();
  }

  advance() {
    this.clearTimer();
    switch (this.phase) {
      case 'spin_ready':       this._doSpin();               break;
      case 'spinning':         this._showSpinResult();       break;
      case 'adj_result':       this._beginTaskIntro();       break;
      case 'event_result':     this._beginEventResolve();    break;
      case 'event_resolve':    this._afterEvent();           break;
      case 'task_intro':       this._beginSkit();            break;
      case 'skit':             this._endSkit();              break;
      case 'performance_vote': this._finalizeSkitResult();   break;
      case 'skit_result':      this._nextTurn();             break;
    }
  }

  handlePlayerAction(player, data) {
    const spinner = this._currentPlayer();

    switch (data.type) {

      // ── Current player spins the wheel ─────────────────────
      case 'spin':
        if (this.phase === 'spin_ready' && player.id === spinner.id) {
          this.clearTimer();
          this._doSpin();
        }
        break;

      // ── Event resolution: pick a player ────────────────────
      case 'event_choice':
        if (this.phase === 'event_resolve' && player.id === spinner.id) {
          this.clearTimer();
          this._resolveEventChoice(data);
        }
        break;

      // ── Event resolution: wildcard — pick an adjective ─────
      case 'event_choose_tag':
        if (this.phase === 'event_resolve' && player.id === spinner.id) {
          this.clearTimer();
          const adj = (data.tag || '').trim();
          if (adjectives.includes(adj)) {
            spinner.tags.push(adj);
            this._afterEvent();
          }
        }
        break;

      // ── Audience vote for audience_pick event ──────────────
      case 'audience_vote':
        if (this.phase === 'event_resolve' && player.id !== spinner.id) {
          const adj = (data.tag || '').trim();
          if (adjectives.includes(adj) && !this.audienceVotes.has(player.id)) {
            this.audienceVotes.set(player.id, adj);
            const needed = this.players.length - 1;
            if (this.audienceVotes.size >= needed) {
              this.clearTimer();
              this._resolveAudiencePick();
            } else {
              // Let everyone know how many votes are in
              this.broadcast('host:audience_votes', {
                votesIn: this.audienceVotes.size,
                needed,
              });
            }
          }
        }
        break;

      // ── Performer signals they are done with the skit ───────
      case 'speaker_done': {
        if (this.phase !== 'skit') break;
        const isPerformer = this.currentPerformers.some(p => p.id === player.id);
        if (!isPerformer) break;
        this.clearTimer();
        this._beginPerfVote();
        break;
      }

      // ── Call out a performer's tag during skit ─────────────
      case 'callout_tag':
        if (this.phase === 'skit') {
          this._handleCallout(player, data.targetId, data.tag);
        }
        break;

      // ── Rate the performance (1–10) after the skit ─────────
      case 'performance_vote': {
        if (this.phase !== 'performance_vote') break;
        const isPerformer = this.currentPerformers.some(p => p.id === player.id);
        if (isPerformer || this.performanceVotes.has(player.id)) break;
        const rating = Math.max(1, Math.min(10, Math.round(Number(data.rating))));
        if (isNaN(rating)) break;

        this.performanceVotes.set(player.id, rating);
        this.send(player.id, 'player:phase', {
          phase: 'performance_vote', role: 'voted', yourRating: rating,
        });

        const nonPerformers = this.players.filter(p =>
          !this.currentPerformers.some(cp => cp.id === p.id)
        );
        const avg = this._avgVotes();
        this.broadcast('host:vote_update', {
          votesIn:   this.performanceVotes.size,
          voterCount: nonPerformers.length,
          avgRating:  +avg.toFixed(1),
        });

        if (this.performanceVotes.size >= nonPerformers.length) {
          this.clearTimer();
          this._finalizeSkitResult();
        }
        break;
      }
    }
  }

  // ── Spin phases ────────────────────────────────────────────

  _beginSpinReady() {
    this.phase = 'spin_ready';
    const spinner     = this._currentPlayer();
    const perRound    = this.players.length;
    const roundNumber = Math.floor(this.turnIdx / perRound) + 1;
    const turnInRound = (this.turnIdx % perRound) + 1;

    this.broadcast('host:phase', {
      phase: 'spin_ready',
      spinner:       this._pub(spinner),
      roundNumber,
      maxRounds:     this.maxRounds,
      turnInRound,
      playersPerRound: perRound,
      wheelSegments: this.wheelSegments,
      allPlayers:    this._allPub(),
    });

    this.players.forEach(p => {
      this.send(p.id, 'player:phase', {
        phase: 'spin_ready',
        role:  p.id === spinner.id ? 'spinner' : 'watcher',
        spinner:       this._pub(spinner),
        roundNumber,
        maxRounds:     this.maxRounds,
        turnInRound,
        playersPerRound: perRound,
        wheelSegments: this.wheelSegments,
        allPlayers:    this._allPub(),
      });
    });
  }

  _doSpin() {
    this.phase = 'spinning';
    const spinner     = this._currentPlayer();
    const resultIndex = Math.floor(Math.random() * WHEEL_SEGMENTS);
    const result      = this.wheelSegments[resultIndex];
    this._pendingSpinResult = { resultIndex, result };

    this.broadcast('host:phase', {
      phase: 'spinning',
      spinner: this._pub(spinner),
      resultIndex,
      result,
      wheelSegments: this.wheelSegments,
    });

    this.players.forEach(p => {
      this.send(p.id, 'player:phase', {
        phase: 'spinning',
        role: p.id === spinner.id ? 'spinner' : 'watcher',
        spinner: this._pub(spinner),
        resultIndex,
        result,
        wheelSegments: this.wheelSegments,
      });
    });

    this.startTimer(T_SPIN_RESULT, () => this._showSpinResult());
  }

  _showSpinResult() {
    const { result } = this._pendingSpinResult;
    const spinner = this._currentPlayer();

    if (result.type === 'adjective') {
      spinner.tags.push(result.value);
      this._showAdjResult(result.value);
    } else {
      this._showEventResult(result);
    }
  }

  _showAdjResult(adjective) {
    this.phase = 'adj_result';
    const spinner = this._currentPlayer();

    this.broadcast('host:phase', {
      phase: 'adj_result',
      spinner:    this._pub(spinner),
      adjective,
      allPlayers: this._allPub(),
    });

    this.players.forEach(p => {
      this.send(p.id, 'player:phase', {
        phase:     'adj_result',
        adjective,
        spinner:   this._pub(spinner),
        isSpinner: p.id === spinner.id,
        allPlayers: this._allPub(),
      });
    });

    this.startTimer(T_ADJ_RESULT, () => this._beginTaskIntro());
  }

  // ── Event handling ─────────────────────────────────────────

  _showEventResult(event) {
    this.phase       = 'event_result';
    this.pendingEvent = event;
    const spinner     = this._currentPlayer();

    this.broadcast('host:phase', {
      phase:     'event_result',
      spinner:   this._pub(spinner),
      event,
      allPlayers: this._allPub(),
    });

    this.players.forEach(p => {
      this.send(p.id, 'player:phase', {
        phase:     'event_result',
        event,
        spinner:   this._pub(spinner),
        isSpinner: p.id === spinner.id,
        allPlayers: this._allPub(),
      });
    });

    this.startTimer(T_EVENT_RESULT, () => this._beginEventResolve());
  }

  _beginEventResolve() {
    const event   = this.pendingEvent;
    const spinner = this._currentPlayer();

    // Events that need no player choice — resolve immediately
    if (!event.needsChoice || event.needsChoice === false) {
      this._resolveAutoEvent(event);
      return;
    }

    this.phase = 'event_resolve';
    this.audienceVotes.clear();

    const others = this.players.filter(p => p.id !== spinner.id);

    this.broadcast('host:phase', {
      phase:     'event_resolve',
      event,
      spinner:   this._pub(spinner),
      allPlayers: this._allPub(),
    });

    this.players.forEach(p => {
      if (p.id === spinner.id) {
        this.send(p.id, 'player:phase', {
          phase:     'event_resolve',
          role:      'chooser',
          event,
          // For player/steal/give: list of other players with tags
          options:   event.needsChoice === 'player'    ? others.map(o => this._pub(o)) : null,
          // For wildcard: full adjective list
          adjectives: event.needsChoice === 'adjective' ? adjectives : null,
        });
      } else {
        this.send(p.id, 'player:phase', {
          phase:     'event_resolve',
          role:      event.needsChoice === 'vote' ? 'voter' : 'waiting',
          event,
          spinner:   this._pub(spinner),
          // For audience_pick: give voters the adjective list to vote on
          adjectives: event.needsChoice === 'vote' ? adjectives : null,
        });
      }
    });

    this.startTimer(T_EVENT_RESOLVE_AUTO, () => this._afterEvent());
  }

  _resolveAutoEvent(event) {
    const spinner = this._currentPlayer();
    const others  = this.players.filter(p => p.id !== spinner.id);

    switch (event.action) {
      case 'swap_random': {
        const target = others[Math.floor(Math.random() * others.length)];
        if (target) {
          const tmp = [...spinner.tags];
          spinner.tags = [...target.tags];
          target.tags  = tmp;
        }
        break;
      }
      case 'add_tag': {
        // Spin again, adjective segments only
        const adjIndices = this.wheelSegments
          .map((s, i) => s.type === 'adjective' ? i : -1)
          .filter(i => i >= 0);
        const idx = adjIndices[Math.floor(Math.random() * adjIndices.length)];
        spinner.tags.push(this.wheelSegments[idx].value);
        break;
      }
      case 'immunity':
        spinner.immune = true;
        break;
      case 'everyone_rotates': {
        const tagsCopy = this.players.map(p => [...p.tags]);
        this.players.forEach((p, i) => {
          const fromIdx = (i - 1 + this.players.length) % this.players.length;
          p.tags = tagsCopy[fromIdx];
        });
        break;
      }
    }

    this._afterEvent();
  }

  _resolveEventChoice(data) {
    const event   = this.pendingEvent;
    const spinner = this._currentPlayer();
    const target  = this.players.find(p => p.id === data.targetId);

    switch (event.action) {
      case 'steal_tag':
        if (target && target.tags.length > 0) {
          const stolen = target.tags.pop();
          spinner.tags.push(stolen);
        }
        break;
      case 'give_tag':
        if (target && spinner.tags.length > 0) {
          const given = spinner.tags.pop();
          target.tags.push(given);
        }
        break;
    }

    this._afterEvent();
  }

  _resolveAudiencePick() {
    const spinner = this._currentPlayer();
    // Tally votes
    const tally = new Map();
    this.audienceVotes.forEach(adj => {
      tally.set(adj, (tally.get(adj) || 0) + 1);
    });
    const winner = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    if (winner) spinner.tags.push(winner[0]);
    this._afterEvent();
  }

  _afterEvent() {
    this.pendingEvent = null;
    // Broadcast updated player state before moving on
    this.broadcast('host:phase', {
      phase:     'event_applied',
      allPlayers: this._allPub(),
    });
    this.players.forEach(p => {
      this.send(p.id, 'player:phase', {
        phase: 'event_applied',
        allPlayers: this._allPub(),
      });
    });
    setTimeout(() => this._beginTaskIntro(), 2500);
  }

  // ── Task / skit ────────────────────────────────────────────

  _beginTaskIntro() {
    this.phase = 'task_intro';
    const spinner = this._currentPlayer();

    // Cap performers at floor(n/2), max 4 — ensures audience always ≥ half
    const maxPerformers = Math.min(4, Math.floor(this.players.length / 2));

    const candidates = tasks.filter(t => {
      const count = Number(t.playerCount);
      return !isNaN(count) && count >= 1 && count <= maxPerformers;
    });
    // Fallback to solo if no tasks fit (e.g. tiny player count)
    const pool = candidates.length > 0 ? candidates : tasks.filter(t => t.playerCount === 1);
    const task = pool[Math.floor(Math.random() * pool.length)];

    // Spinner is always P1; fill remaining slots from shuffled others
    const others     = this._shuffle(this.players.filter(p => p.id !== spinner.id));
    const performers = [spinner, ...others.slice(0, Number(task.playerCount) - 1)];

    this.currentPerformers = performers;
    this.currentTask       = {
      ...task,
      prompt: task.prompt
        .replace(/\{P1\}/g, performers[0]?.name ?? 'Player 1')
        .replace(/\{P2\}/g, performers[1]?.name ?? 'Player 2')
        .replace(/\{P3\}/g, performers[2]?.name ?? 'Player 3')
        .replace(/\{P4\}/g, performers[3]?.name ?? 'Player 4'),
    };

    const performerIds = new Set(performers.map(p => p.id));

    this.broadcast('host:phase', {
      phase:      'task_intro',
      task:       this.currentTask,
      performers: performers.map(p => this._pub(p)),
      allPlayers: this._allPub(),
    });

    this.players.forEach(p => {
      this.send(p.id, 'player:phase', {
        phase:       'task_intro',
        task:        this.currentTask,
        performers:  performers.map(q => this._pub(q)),
        isPerformer: performerIds.has(p.id),
        allPlayers:  this._allPub(),
      });
    });

    this.startTimer(T_TASK_INTRO, () => this._beginSkit());
  }

  _beginSkit() {
    this.phase    = 'skit';
    this.callouts  = new Map();
    this.failedTags = new Set();

    const performerIds = new Set(this.currentPerformers.map(p => p.id));
    const nonPerformers = this.players.filter(p => !performerIds.has(p.id));

    this.broadcast('host:phase', {
      phase:         'skit',
      task:          this.currentTask,
      performers:    this.currentPerformers.map(p => this._pub(p)),
      nonPerformerCount: nonPerformers.length,
      threshold:     this._threshold(nonPerformers.length),
      calloutData:   this._buildCalloutData(),
      timeLeft:      T_SKIT,
    });

    this.players.forEach(p => {
      const isPerformer = performerIds.has(p.id);
      this.send(p.id, 'player:phase', {
        phase:       'skit',
        role:        isPerformer ? 'performer' : 'voter',
        task:        this.currentTask,
        performers:  this.currentPerformers.map(q => this._pub(q)),
        nonPerformerCount: nonPerformers.length,
        threshold:   this._threshold(nonPerformers.length),
        calloutData: this._buildCalloutData(),
        timeLeft:    T_SKIT,
        myTags:      isPerformer ? p.tags : undefined,
        immune:      isPerformer ? p.immune : undefined,
      });
    });

    this.startTimer(T_SKIT, () => this._endSkit());
  }

  _handleCallout(voter, targetId, tag) {
    const isNonPerformer = !this.currentPerformers.some(p => p.id === voter.id);
    if (!isNonPerformer) return;

    const performer = this.currentPerformers.find(p => p.id === targetId);
    if (!performer || !performer.tags.includes(tag)) return;
    if (performer.immune) return;

    const key = `${targetId}:${tag}`;
    if (!this.callouts.has(key)) this.callouts.set(key, new Set());

    const callers = this.callouts.get(key);
    if (callers.has(voter.id)) return;  // already called this one
    callers.add(voter.id);

    const performerIds  = new Set(this.currentPerformers.map(p => p.id));
    const nonPerformers = this.players.filter(p => !performerIds.has(p.id));
    const threshold     = this._threshold(nonPerformers.length);

    // New majority reached?
    if (callers.size >= threshold && !this.failedTags.has(key)) {
      this.failedTags.add(key);
      this.broadcast('host:tag_failed', {
        performerId: targetId,
        performerName: performer.name,
        tag,
        callouts: callers.size,
      });
    }

    const calloutData = this._buildCalloutData();
    this.broadcast('host:callout_update', { calloutData });

    // Push updated skit state to voters so their buttons refresh
    const performerIds2 = new Set(this.currentPerformers.map(p => p.id));
    this.players.filter(p => !performerIds2.has(p.id)).forEach(p => {
      this.send(p.id, 'player:phase', {
        phase:       'skit',
        role:        'voter',
        task:        this.currentTask,
        performers:  this.currentPerformers.map(q => this._pub(q)),
        nonPerformerCount: nonPerformers.length,
        threshold,
        calloutData,
        myCallouts:  this._voterCallouts(p.id),
      });
    });
  }

  _endSkit() {
    this.phase = 'performance_vote';
    this.clearTimer();
    this.performanceVotes.clear();

    const performerIds  = new Set(this.currentPerformers.map(p => p.id));
    const nonPerformers = this.players.filter(p => !performerIds.has(p.id));

    this.broadcast('host:phase', {
      phase:      'performance_vote',
      performers: this.currentPerformers.map(p => this._pub(p)),
      voterCount: nonPerformers.length,
      votesIn:    0,
      avgRating:  null,
      timeLeft:   T_PERF_VOTE,
    });

    this.players.forEach(p => {
      this.send(p.id, 'player:phase', {
        phase:      'performance_vote',
        role:       performerIds.has(p.id) ? 'performer' : 'voter',
        performers: this.currentPerformers.map(q => this._pub(q)),
        timeLeft:   T_PERF_VOTE,
      });
    });

    this.startTimer(T_PERF_VOTE, () => this._finalizeSkitResult());
  }

  _finalizeSkitResult() {
    this.phase = 'skit_result';
    this.clearTimer();

    const avgRating  = this._avgVotes();                       // 0-10 (0 if no votes)
    const ratingPts  = Math.round(avgRating * SCORE_PER_RATING_POINT); // 0-250

    const performerResults = this.currentPerformers.map(p => {
      const failedTagsForPlayer = p.tags.filter(tag => this.failedTags.has(`${p.id}:${tag}`));
      const survivedTags        = p.tags.filter(tag => !this.failedTags.has(`${p.id}:${tag}`));
      const immuneBonus         = p.immune ? IMMUNITY_BONUS : 0;
      const penalty             = failedTagsForPlayer.length * FAILED_TAG_PENALTY;
      const delta               = Math.max(0, ratingPts + immuneBonus - penalty);
      p.score += delta;
      p.immune = false;
      return {
        ...this._pub(p),
        failedTags: failedTagsForPlayer,
        survivedTags,
        ratingPts,
        immuneBonus,
        penalty,
        delta,
      };
    });

    // Reward voters who contributed to majority callouts
    this.failedTags.forEach(key => {
      const callers = this.callouts.get(key);
      if (callers) {
        callers.forEach(voterId => {
          const voter = this.players.find(p => p.id === voterId);
          if (voter) voter.score += CALLOUT_REWARD;
        });
      }
    });

    const payload = {
      phase:          'skit_result',
      avgRating:      +avgRating.toFixed(1),
      ratingPts,
      performerResults,
      allPlayers:     this._allPub(),
    };

    this.broadcast('host:phase', payload);
    this.players.forEach(p => {
      this.send(p.id, 'player:phase', {
        ...payload,
        myDelta: performerResults.find(r => r.id === p.id)?.delta ?? 0,
      });
    });

    this.startTimer(T_SKIT_RESULT, () => this._nextTurn());
  }

  _avgVotes() {
    if (this.performanceVotes.size === 0) return 0;
    let sum = 0;
    this.performanceVotes.forEach(v => sum += v);
    return sum / this.performanceVotes.size;
  }

  _nextTurn() {
    this.turnIdx++;
    if (this.turnIdx >= this.playerOrder.length) {
      this._endGame();
    } else {
      this._beginSpinReady();
    }
  }

  _endGame() {
    this.phase = 'game_over';
    this.clearTimer();
    const sorted = [...this.players].sort((a, b) => b.score - a.score);
    const payload = {
      phase:   'game_over',
      players: sorted.map((p, i) => ({ ...this._pub(p), rank: i + 1 })),
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

  _currentPlayer() { return this.playerOrder[this.turnIdx]; }

  _threshold(nonPerformerCount) { return Math.ceil(nonPerformerCount / 2); }

  _pub(p) {
    return { id: p.id, name: p.name, color: p.color, tags: [...p.tags], score: p.score, immune: p.immune };
  }

  _allPub() { return this.players.map(p => this._pub(p)); }

  _buildCalloutData() {
    // { `${performerId}:${tag}`: { count, failed } }
    const data = {};
    this.callouts.forEach((callers, key) => {
      data[key] = { count: callers.size, failed: this.failedTags.has(key) };
    });
    return data;
  }

  _voterCallouts(voterId) {
    // Which tag keys this specific voter has already called out
    const mine = {};
    this.callouts.forEach((callers, key) => {
      if (callers.has(voterId)) mine[key] = true;
    });
    return mine;
  }

  updatePlayerId(oldId, newId) {
    _transferMapKey(this.audienceVotes, oldId, newId);
    _transferMapKey(this.performanceVotes, oldId, newId);

    // Update callout keys where old ID was the performer
    for (const key of [...this.callouts.keys()]) {
      if (key.startsWith(oldId + ':')) {
        const callers = this.callouts.get(key);
        this.callouts.delete(key);
        this.callouts.set(newId + key.slice(oldId.length), callers);
      }
    }
    // Update caller IDs inside callout Sets
    for (const callers of this.callouts.values()) {
      if (callers.has(oldId)) { callers.delete(oldId); callers.add(newId); }
    }
    // Update failedTags where old ID was the performer
    for (const key of [...this.failedTags]) {
      if (key.startsWith(oldId + ':')) {
        this.failedTags.delete(key);
        this.failedTags.add(newId + key.slice(oldId.length));
      }
    }
  }

  _buildWheel() {
    const shuffledAdj = this._shuffle([...adjectives]);
    const shuffledEvt = this._shuffle([...events]);
    const segments = [];
    let a = 0, e = 0;
    for (let i = 0; i < WHEEL_SEGMENTS; i++) {
      if ((i + 1) % 4 === 0) {
        segments.push({ type: 'event', ...shuffledEvt[e++ % shuffledEvt.length] });
      } else {
        segments.push({ type: 'adjective', value: shuffledAdj[a++ % shuffledAdj.length] });
      }
    }
    return segments;
  }

  _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

module.exports = TagGame;
