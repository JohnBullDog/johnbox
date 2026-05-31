/**
 * TagGame — "Tag You're Out"
 *
 * Flow per turn:
 *   spin_ready → spinning → adj_result | event_result → [event_resolve] →
 *   task_intro → skit → skit_result → [next turn or game_over]
 *
 * Input types:
 *   spin_ready   → player taps SPIN  (type: 'spin')
 *   event_resolve → player picks target player / adjective / submits audience vote
 *                   (type: 'event_choice' | 'event_choose_tag' | 'audience_vote')
 *   skit         → non-performers tap tags  (type: 'callout_tag', targetId, tag)
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

const T_SPIN_RESULT  = 5;   // seconds wheel spins before revealing
const T_ADJ_RESULT   = 4;
const T_EVENT_RESULT = 5;
const T_EVENT_RESOLVE_AUTO = 30;  // auto-skip event resolution after 30s
const T_TASK_INTRO   = 6;
const T_SKIT         = 120;
const T_SKIT_RESULT  = 8;
const WHEEL_SEGMENTS = 24;

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
    this.pendingEvent = null;
    this.audienceVotes = new Map(); // playerId → suggested adjective
  }

  // ── Lifecycle ──────────────────────────────────────────────

  start(players) {
    this.players     = players.map(p => ({ ...p, score: 0, tags: [], immune: false }));
    this.playerOrder = this._shuffle([...this.players]);
    this.turnIdx     = 0;
    this._beginSpinReady();
  }

  advance() {
    this.clearTimer();
    switch (this.phase) {
      case 'spin_ready':    this._doSpin();            break;
      case 'spinning':      this._showSpinResult();    break;
      case 'adj_result':    this._beginTaskIntro();    break;
      case 'event_result':  this._beginEventResolve(); break;
      case 'event_resolve': this._afterEvent();        break;
      case 'task_intro':    this._beginSkit();         break;
      case 'skit':          this._endSkit();           break;
      case 'skit_result':   this._nextTurn();          break;
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

      // ── Call out a performer's tag during skit ─────────────
      case 'callout_tag':
        if (this.phase === 'skit') {
          this._handleCallout(player, data.targetId, data.tag);
        }
        break;
    }
  }

  // ── Spin phases ────────────────────────────────────────────

  _beginSpinReady() {
    this.phase = 'spin_ready';
    const spinner = this._currentPlayer();

    this.broadcast('host:phase', {
      phase: 'spin_ready',
      spinner:      this._pub(spinner),
      turnNumber:   this.turnIdx + 1,
      totalTurns:   this.playerOrder.length,
      wheelSegments: this.wheelSegments,
      allPlayers:   this._allPub(),
    });

    this.players.forEach(p => {
      this.send(p.id, 'player:phase', {
        phase: 'spin_ready',
        role: p.id === spinner.id ? 'spinner' : 'watcher',
        spinner: this._pub(spinner),
        wheelSegments: this.wheelSegments,
        allPlayers: this._allPub(),
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

    // Pick task based on available player count
    const candidates = tasks.filter(t =>
      t.playerCount === 1 ||
      (t.playerCount === 2 && this.players.length >= 2) ||
      t.playerCount === 'all'
    );
    const task = candidates[Math.floor(Math.random() * candidates.length)];

    // Assign performers
    let performers = [spinner];
    if (task.playerCount === 2) {
      const others = this.players.filter(p => p.id !== spinner.id);
      performers.push(others[Math.floor(Math.random() * others.length)]);
    } else if (task.playerCount === 'all') {
      performers = [...this.players];
    }

    this.currentPerformers = performers;
    this.currentTask       = {
      ...task,
      prompt: task.prompt
        .replace(/\{P1\}/g, performers[0]?.name ?? 'Player 1')
        .replace(/\{P2\}/g, performers[1]?.name ?? 'Player 2'),
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
    this.phase = 'skit_result';
    this.clearTimer();

    const performerResults = this.currentPerformers.map(p => {
      const failedTagsForPlayer = p.tags.filter(tag =>
        this.failedTags.has(`${p.id}:${tag}`)
      );
      const survivedTags = p.tags.filter(tag =>
        !this.failedTags.has(`${p.id}:${tag}`)
      );
      const delta = (p.immune ? 100 : 0) + survivedTags.length * 100;
      p.score += delta;
      p.immune = false;  // immunity consumed
      return { ...this._pub(p), failedTags: failedTagsForPlayer, survivedTags, delta };
    });

    // Voters who contributed to a majority callout get points
    this.failedTags.forEach(key => {
      const callers = this.callouts.get(key);
      if (callers) {
        callers.forEach(voterId => {
          const voter = this.players.find(p => p.id === voterId);
          if (voter) { voter.score += 50; }
        });
      }
    });

    const payload = {
      phase:            'skit_result',
      performerResults,
      allPlayers:       this._allPub(),
      failedTagCount:   this.failedTags.size,
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

  _buildWheel() {
    const shuffledAdj = this._shuffle([...adjectives]);
    const shuffledEvt = this._shuffle([...events]);
    const segments = [];
    let a = 0, e = 0;
    for (let i = 0; i < WHEEL_SEGMENTS; i++) {
      if ((i + 1) % 6 === 0) {
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
