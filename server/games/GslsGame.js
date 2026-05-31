/**
 * GslsGame — "General Statement's Last Stand"
 *
 * Each turn one player gives a live verbal speech. They receive a prompt that is
 * either the TRUE topic or a DECOY (50/50) — they cannot tell which. A randomly
 * chosen aide sees BOTH prompts and can sketch hints on a canvas, sending them
 * to the speaker as "napkins". The rest of the audience sees only the true topic
 * and rates the speech live with cheer/boo buttons.
 *
 * Phase flow (normal turn):
 *   turn_setup → prep → part1 → part2 → part3 → voting → reveal → [next|last_stand|game_over]
 *
 * Phase flow (Last Stand — debate):
 *   last_stand_intro → last_stand_prep → last_stand_debate →
 *   last_stand_heckle → last_stand_challenge → last_stand_voting → last_stand_reveal →
 *   [next normal turn or game_over]
 *
 * Scoring (normal turn):
 *   Speaker   = max(0, Σ capped_nets) × 10   where capped_net = clamp(cheers−boos, ±5)
 *   Aide      = ceil(speaker_score × 0.40)
 *   Deception = +150 if speaker had decoy AND majority voted "true prompt"
 *   Audience  = +50 per correct true/decoy guess
 *
 * Scoring (Last Stand):
 *   Winner    = +200 pts
 *   Each audience member who voted for the winner = +50 pts
 *
 * Actions from players:
 *   cheer / boo            audience during parts 1-3 and last_stand_debate/challenge
 *   aide_draw              aide streams canvas strokes (forwarded to host)
 *   send_napkin            aide sends canvas snapshot to speaker
 *   submit_heckle          audience submits question in part3 / last_stand_heckle
 *   submit_vote            audience votes 'true'|'decoy' in voting
 *   last_stand_vote        audience votes winner player ID in last_stand_voting
 */

const BaseGame = require('./BaseGame');
const ALL_PROMPTS = require('../../data/gsls_prompts.json');

const CHEER_CAP          = 5;
const SCORE_MULTIPLIER   = 10;
const AIDE_CUT           = 0.40;
const DECEPTION_BONUS    = 150;
const GUESS_BONUS        = 50;
const LS_WIN_BONUS       = 200;
const LS_VOTE_BONUS      = 50;

const T_SETUP            = 4;
const T_PREP             = 30;
const T_PART1            = 45;
const T_PART2            = 60;
const T_PART3_INPUT      = 20;
const T_PART3_RESPOND    = 45;
const T_VOTING           = 20;
const T_REVEAL           = 10;

const T_LS_INTRO         = 5;
const T_LS_PREP          = 30;
const T_LS_DEBATE        = 150;
const T_LS_HECKLE        = 20;
const T_LS_CHALLENGE     = 45;
const T_LS_VOTING        = 20;
const T_LS_REVEAL        = 10;

// Last Stand triggers every 3rd turn AND always on the final turn.
function isLastStand(turnNumber, totalTurns) {
  if (turnNumber === totalTurns) return true;
  if (totalTurns >= 3 && turnNumber % 3 === 0) return true;
  return false;
}

class GslsGame extends BaseGame {
  constructor(roomCode, io) {
    super(roomCode, io);

    this.maxRounds   = 1;
    this.turnNumber  = 0;   // turns completed so far
    this.totalTurns  = 0;   // players × rounds
    this.speakerIdx  = 0;   // index into this.players

    // Per-turn state
    this.aideId          = null;
    this.truePrompt      = null;
    this.decoyPrompt     = null;
    this.speakerHasTrue  = false;
    this.napkins         = [];     // [{imageData}] delivered to speaker
    this.reactions       = new Map(); // playerId → {cheers, boos}
    this.heckles         = new Map(); // playerId → string
    this.votes           = new Map(); // playerId → 'true'|'decoy'
    this.usedPromptIds   = new Set();

    // Last Stand state
    this.isLastStandTurn = false;
    this.debaterIds      = [];   // [id1, id2]
    this.debaterPrompts  = {};   // id → prompt object
    this.lsReactions     = new Map(); // playerId → {[debaterId]: {cheers,boos}} — unused for simplicity (just winner vote)
    this.lsVotes         = new Map(); // playerId → winnerId
    this.lsHeckles       = new Map(); // playerId → string
  }

  // Tag every host:phase and player:phase with game:'gsls' so client handlers
  // don't collide with SketchMatch/TagGame phases that share the same name.
  broadcast(event, data) {
    super.broadcast(event, event === 'host:phase' ? { ...data, game: 'gsls' } : data);
  }
  send(socketId, event, data) {
    super.send(socketId, event, event === 'player:phase' ? { ...data, game: 'gsls' } : data);
  }

  // ── Lifecycle ────────────────────────────────────────────────

  start(players, options = {}) {
    this.maxRounds  = Math.max(1, options.rounds ?? 3);
    this.players    = players.map(p => ({ ...p, score: 0 }));
    this.totalTurns = this.players.length * this.maxRounds;
    this._beginNextTurn();
  }

  advance() {
    this.clearTimer();
    switch (this.phase) {
      case 'turn_setup':        this._beginPrep();           break;
      case 'prep':              this._beginPart1();          break;
      case 'part1':             this._beginPart2();          break;
      case 'part2':             this._beginPart3();          break;
      case 'part3':             this._beginPart3Respond();   break;
      case 'part3_respond':     this._beginVoting();         break;
      case 'voting':            this._beginReveal();         break;
      case 'reveal':            this._afterReveal();         break;
      case 'last_stand_intro':  this._beginLsPep();           break;
      case 'last_stand_prep':   this._beginLsDebate();       break;
      case 'last_stand_debate': this._beginLsHeckle();       break;
      case 'last_stand_heckle': this._beginLsChallenge();    break;
      case 'last_stand_challenge': this._beginLsVoting();    break;
      case 'last_stand_voting': this._beginLsReveal();       break;
      case 'last_stand_reveal': this._afterReveal();         break;
    }
  }

  handlePlayerAction(player, data) {
    switch (data.type) {

      // ── Speaker signals they are done with the current part ─
      case 'speaker_done': {
        const speakerPhases = ['part1', 'part2', 'part3_respond'];
        if (!speakerPhases.includes(this.phase)) break;
        if (player.id !== this._speakerId()) break;
        this.clearTimer();
        this.advance();
        break;
      }

      case 'cheer':
      case 'boo': {
        const reactionPhases = ['part1','part2','part3','part3_respond','last_stand_debate','last_stand_challenge'];
        if (!reactionPhases.includes(this.phase)) break;
        const sid = player.id;
        if (!this.reactions.has(sid)) this.reactions.set(sid, { cheers: 0, boos: 0 });
        const r = this.reactions.get(sid);
        if (data.type === 'cheer') r.cheers++; else r.boos++;
        this.broadcast('gsls:reaction_update', { reactions: this._reactionSummary() });
        break;
      }

      case 'aide_draw': {
        if (player.id !== this.aideId) break;
        if (!['prep','part1','part2','part3','part3_respond'].includes(this.phase)) break;
        this.broadcast('gsls:aide_draw', { event: data.event });
        break;
      }

      case 'send_napkin': {
        if (player.id !== this.aideId) break;
        if (!['prep','part1','part2','part3','part3_respond'].includes(this.phase)) break;
        if (!data.imageData) break;
        const napkin = { imageData: data.imageData, index: this.napkins.length };
        this.napkins.push(napkin);
        // Deliver to speaker
        this.io.to(this._speakerId()).emit('gsls:napkin', napkin);
        // Tell host a napkin was sent
        this.broadcast('gsls:napkin_sent', { count: this.napkins.length });
        break;
      }

      case 'submit_heckle': {
        if (!['part3','last_stand_heckle'].includes(this.phase)) break;
        const sid = player.id;
        // Speaker and aide can't submit heckles; debaters can't in last stand
        if (sid === this._speakerId()) break;
        if (sid === this.aideId) break;
        if (this.isLastStandTurn && this.debaterIds.includes(sid)) break;
        if (this.heckles.has(sid) || this.lsHeckles.has(sid)) break;
        const text = (data.text ?? '').trim().slice(0, 80);
        if (!text) break;
        if (this.isLastStandTurn) {
          this.lsHeckles.set(sid, text);
        } else {
          this.heckles.set(sid, text);
        }
        const audienceSize = this._audienceSize();
        const submitted = this.isLastStandTurn ? this.lsHeckles.size : this.heckles.size;
        this.broadcast('gsls:heckle_count', { submitted, total: audienceSize });
        if (submitted >= audienceSize) { this.clearTimer(); this.advance(); }
        break;
      }

      case 'submit_vote': {
        if (this.phase !== 'voting') break;
        const sid = player.id;
        if (sid === this._speakerId() || sid === this.aideId) break;
        if (this.votes.has(sid)) break;
        if (!['true','decoy'].includes(data.vote)) break;
        this.votes.set(sid, data.vote);
        this.broadcast('gsls:vote_count', { voted: this.votes.size, total: this._audienceSize() });
        if (this.votes.size >= this._audienceSize()) { this.clearTimer(); this._beginReveal(); }
        break;
      }

      case 'last_stand_vote': {
        if (this.phase !== 'last_stand_voting') break;
        const sid = player.id;
        if (this.debaterIds.includes(sid)) break;
        if (this.lsVotes.has(sid)) break;
        if (!this.debaterIds.includes(data.winnerId)) break;
        this.lsVotes.set(sid, data.winnerId);
        const lsAudience = this.players.length - 2;
        this.broadcast('gsls:vote_count', { voted: this.lsVotes.size, total: lsAudience });
        if (this.lsVotes.size >= lsAudience) { this.clearTimer(); this._beginLsReveal(); }
        break;
      }
    }
  }

  // ── Normal turn phases ───────────────────────────────────────

  _beginNextTurn() {
    this.turnNumber++;
    if (isLastStand(this.turnNumber, this.totalTurns)) {
      this._beginLastStandIntro();
      return;
    }
    this.isLastStandTurn = false;
    this._resetTurnState();

    // Pick prompts
    const pool = ALL_PROMPTS.filter(p => !this.usedPromptIds.has(p.id));
    const src  = pool.length ? pool : ALL_PROMPTS;
    this.truePrompt  = src[Math.floor(Math.random() * src.length)];
    this.usedPromptIds.add(this.truePrompt.id);

    const decoyPool = this.truePrompt.confusable
      .map(id => ALL_PROMPTS.find(p => p.id === id))
      .filter(Boolean);
    this.decoyPrompt = decoyPool[Math.floor(Math.random() * decoyPool.length)] ?? this.truePrompt;

    this.speakerHasTrue = Math.random() < 0.5;

    // Pick aide — random player that is not the speaker
    const nonSpeakers = this.players.filter(p => p.id !== this._speakerId());
    this.aideId = nonSpeakers[Math.floor(Math.random() * nonSpeakers.length)].id;

    this.phase = 'turn_setup';
    const speaker = this._speaker();
    const aide    = this._findPlayer(this.aideId);

    this.broadcast('host:phase', {
      phase: 'turn_setup',
      turnNumber: this.turnNumber, totalTurns: this.totalTurns,
      speaker: { id: speaker.id, name: speaker.name, color: speaker.color },
      aide:    { id: aide.id,    name: aide.name,    color: aide.color },
      truePromptText: this.truePrompt.text,
    });

    this.players.forEach(p => {
      let role = 'audience';
      if (p.id === speaker.id) role = 'speaker';
      else if (p.id === aide.id) role = 'aide';
      this.send(p.id, 'player:phase', {
        phase: 'turn_setup', role,
        turnNumber: this.turnNumber, totalTurns: this.totalTurns,
        speakerName: speaker.name, speakerColor: speaker.color,
        aideName: aide.name, aideColor: aide.color,
      });
    });

    this.startTimer(T_SETUP, () => this._beginPrep());
  }

  _beginPrep() {
    this.phase = 'prep';
    const speaker    = this._speaker();
    const aide       = this._findPlayer(this.aideId);
    const forbidden  = this.truePrompt.forbidden;
    const speakerPromptText = this.speakerHasTrue ? this.truePrompt.text : this.decoyPrompt.text;

    this.broadcast('host:phase', {
      phase: 'prep',
      speakerName: speaker.name, speakerColor: speaker.color,
      aideName: aide.name, aideColor: aide.color,
    });

    this.players.forEach(p => {
      if (p.id === speaker.id) {
        this.send(p.id, 'player:phase', {
          phase: 'prep', role: 'speaker',
          promptText: speakerPromptText,
          forbidden,
          timeLeft: T_PREP,
        });
      } else if (p.id === aide.id) {
        this.send(p.id, 'player:phase', {
          phase: 'prep', role: 'aide',
          truePromptText: this.truePrompt.text,
          decoyPromptText: this.decoyPrompt.text,
          speakerName: speaker.name,
          timeLeft: T_PREP,
        });
      } else {
        this.send(p.id, 'player:phase', {
          phase: 'prep', role: 'audience',
          truePromptText: this.truePrompt.text,
          speakerName: speaker.name,
          aideName: aide.name,
          timeLeft: T_PREP,
        });
      }
    });

    this.startTimer(T_PREP, () => this._beginPart1());
  }

  _beginPart1() {
    this.phase = 'part1';
    const speaker   = this._speaker();
    const aide      = this._findPlayer(this.aideId);
    const forbidden = this.truePrompt.forbidden;

    this.broadcast('host:phase', {
      phase: 'part1',
      speakerName: speaker.name, speakerColor: speaker.color,
      aideName: aide.name, aideColor: aide.color,
      truePromptText: this.truePrompt.text,
      forbidden,
      timeLeft: T_PART1,
    });

    const speakerPromptText = this.speakerHasTrue ? this.truePrompt.text : this.decoyPrompt.text;

    this.players.forEach(p => {
      if (p.id === speaker.id) {
        this.send(p.id, 'player:phase', {
          phase: 'part1', role: 'speaker',
          promptText: speakerPromptText, forbidden, timeLeft: T_PART1,
          napkins: this.napkins,
        });
      } else if (p.id === aide.id) {
        this.send(p.id, 'player:phase', {
          phase: 'part1', role: 'aide',
          truePromptText: this.truePrompt.text, decoyPromptText: this.decoyPrompt.text,
          speakerName: speaker.name, timeLeft: T_PART1,
          napkinsSent: this.napkins.length,
        });
      } else {
        this.send(p.id, 'player:phase', {
          phase: 'part1', role: 'audience',
          truePromptText: this.truePrompt.text, forbidden,
          speakerName: speaker.name, timeLeft: T_PART1,
        });
      }
    });

    this.startTimer(T_PART1, () => this._beginPart2());
  }

  _beginPart2() {
    this.phase = 'part2';
    const speaker = this._speaker();
    const aide    = this._findPlayer(this.aideId);
    const speakerPromptText = this.speakerHasTrue ? this.truePrompt.text : this.decoyPrompt.text;

    this.broadcast('host:phase', {
      phase: 'part2',
      speakerName: speaker.name, speakerColor: speaker.color,
      aideName: aide.name, aideColor: aide.color,
      truePromptText: this.truePrompt.text,
      timeLeft: T_PART2,
    });

    this.players.forEach(p => {
      if (p.id === speaker.id) {
        this.send(p.id, 'player:phase', {
          phase: 'part2', role: 'speaker',
          promptText: speakerPromptText, timeLeft: T_PART2,
          napkins: this.napkins,
        });
      } else if (p.id === aide.id) {
        this.send(p.id, 'player:phase', {
          phase: 'part2', role: 'aide',
          truePromptText: this.truePrompt.text, decoyPromptText: this.decoyPrompt.text,
          speakerName: speaker.name, timeLeft: T_PART2,
          napkinsSent: this.napkins.length,
        });
      } else {
        this.send(p.id, 'player:phase', {
          phase: 'part2', role: 'audience',
          truePromptText: this.truePrompt.text,
          speakerName: speaker.name, timeLeft: T_PART2,
        });
      }
    });

    this.startTimer(T_PART2, () => this._beginPart3());
  }

  _beginPart3() {
    this.phase = 'part3';
    const speaker = this._speaker();
    const aide    = this._findPlayer(this.aideId);
    const audienceSize = this._audienceSize();

    this.broadcast('host:phase', {
      phase: 'part3',
      speakerName: speaker.name, speakerColor: speaker.color,
      audienceSize, hecklesIn: 0,
      timeLeft: T_PART3_INPUT,
    });

    this.players.forEach(p => {
      if (p.id === speaker.id) {
        this.send(p.id, 'player:phase', { phase: 'part3', role: 'speaker' });
      } else if (p.id === aide.id) {
        this.send(p.id, 'player:phase', { phase: 'part3', role: 'aide', napkinsSent: this.napkins.length });
      } else {
        this.send(p.id, 'player:phase', { phase: 'part3', role: 'audience', timeLeft: T_PART3_INPUT });
      }
    });

    this.startTimer(T_PART3_INPUT, () => this._beginPart3Respond());
  }

  _beginPart3Respond() {
    this.phase = 'part3_respond';
    const speaker   = this._speaker();
    const aide      = this._findPlayer(this.aideId);
    const heckleList = [...this.heckles.values()];

    this.broadcast('host:phase', {
      phase: 'part3_respond',
      speakerName: speaker.name, speakerColor: speaker.color,
      heckles: heckleList,
      timeLeft: T_PART3_RESPOND,
    });

    const speakerPromptText = this.speakerHasTrue ? this.truePrompt.text : this.decoyPrompt.text;

    this.players.forEach(p => {
      if (p.id === speaker.id) {
        this.send(p.id, 'player:phase', {
          phase: 'part3_respond', role: 'speaker',
          heckles: heckleList, promptText: speakerPromptText,
          napkins: this.napkins, timeLeft: T_PART3_RESPOND,
        });
      } else if (p.id === aide.id) {
        this.send(p.id, 'player:phase', {
          phase: 'part3_respond', role: 'aide',
          heckles: heckleList, napkinsSent: this.napkins.length,
        });
      } else {
        this.send(p.id, 'player:phase', {
          phase: 'part3_respond', role: 'audience',
          heckles: heckleList, timeLeft: T_PART3_RESPOND,
        });
      }
    });

    this.startTimer(T_PART3_RESPOND, () => this._beginVoting());
  }

  _beginVoting() {
    this.phase = 'voting';
    const speaker = this._speaker();

    this.broadcast('host:phase', {
      phase: 'voting',
      speakerName: speaker.name, speakerColor: speaker.color,
      voted: 0, total: this._audienceSize(),
      timeLeft: T_VOTING,
    });

    this.players.forEach(p => {
      if (p.id === speaker.id || p.id === this.aideId) {
        this.send(p.id, 'player:phase', { phase: 'voting', role: 'waiting' });
      } else {
        this.send(p.id, 'player:phase', {
          phase: 'voting', role: 'voter',
          speakerName: speaker.name, timeLeft: T_VOTING,
        });
      }
    });

    this.startTimer(T_VOTING, () => this._beginReveal());
  }

  _beginReveal() {
    this.phase = 'reveal';
    this.clearTimer();

    const speaker = this._speaker();
    const aide    = this._findPlayer(this.aideId);

    // Tally scores
    let rawNet = 0;
    for (const r of this.reactions.values()) {
      rawNet += Math.max(-CHEER_CAP, Math.min(CHEER_CAP, r.cheers - r.boos));
    }
    let speakerScore = Math.max(0, rawNet) * SCORE_MULTIPLIER;
    const aideScore  = Math.ceil(speakerScore * AIDE_CUT);

    const trueVotes   = [...this.votes.values()].filter(v => v === 'true').length;
    const decoyVotes  = this.votes.size - trueVotes;
    const majorityFooled = !this.speakerHasTrue && trueVotes > this.votes.size / 2;
    const deceptionBonus = majorityFooled ? DECEPTION_BONUS : 0;
    speakerScore += deceptionBonus;

    // Apply scores and audience guess bonuses
    if (speaker) speaker.score += speakerScore;
    if (aide)    aide.score    += aideScore;

    const guessResults = [];
    for (const [pid, vote] of this.votes) {
      const correct = (vote === 'true') === this.speakerHasTrue;
      const p = this._findPlayer(pid);
      if (p && correct) p.score += GUESS_BONUS;
      guessResults.push({ id: pid, vote, correct });
    }

    const payload = {
      phase: 'reveal',
      speakerName: speaker?.name, speakerColor: speaker?.color,
      aideName: aide?.name, aideColor: aide?.color,
      truePromptText: this.truePrompt.text,
      decoyPromptText: this.decoyPrompt.text,
      speakerHadTrue: this.speakerHasTrue,
      speakerScore, deceptionBonus, aideScore,
      trueVotes, decoyVotes,
      guessResults,
      players: this.players.map(p => ({ id: p.id, name: p.name, color: p.color, score: p.score })),
    };

    this.broadcast('host:phase', payload);
    this.players.forEach(p => {
      const myVote = this.votes.get(p.id);
      const myGuessCorrect = myVote !== undefined ? (myVote === 'true') === this.speakerHasTrue : null;
      this.send(p.id, 'player:phase', {
        ...payload,
        myRole: p.id === speaker?.id ? 'speaker' : p.id === aide?.id ? 'aide' : 'audience',
        myVote, myGuessCorrect,
        myScore: p.score,
      });
    });

    this.startTimer(T_REVEAL, () => this._afterReveal());
  }

  _afterReveal() {
    this.speakerIdx = (this.speakerIdx + 1) % this.players.length;
    if (this.turnNumber >= this.totalTurns) {
      this._endGame();
    } else {
      this._beginNextTurn();
    }
  }

  // ── Last Stand phases ────────────────────────────────────────

  _beginLastStandIntro() {
    this.isLastStandTurn = true;
    this._resetLsState();

    // Pick two random debaters
    const shuffled = [...this.players].sort(() => Math.random() - 0.5);
    this.debaterIds = [shuffled[0].id, shuffled[1].id];

    // Assign confusable prompt pair
    const pool = ALL_PROMPTS.filter(p => !this.usedPromptIds.has(p.id));
    const src  = pool.length >= 2 ? pool : ALL_PROMPTS;
    const p1   = src[Math.floor(Math.random() * src.length)];
    this.usedPromptIds.add(p1.id);

    const p2Pool = p1.confusable
      .map(id => ALL_PROMPTS.find(p => p.id === id))
      .filter(p => p && p.id !== p1.id);
    const p2 = p2Pool[Math.floor(Math.random() * p2Pool.length)] ?? src.find(p => p.id !== p1.id) ?? p1;
    this.usedPromptIds.add(p2.id);

    this.debaterPrompts[this.debaterIds[0]] = p1;
    this.debaterPrompts[this.debaterIds[1]] = p2;

    // Combined forbidden words (union of both)
    this._lsForbidden = [...new Set([...p1.forbidden, ...p2.forbidden])];

    this.phase = 'last_stand_intro';
    const d1 = this._findPlayer(this.debaterIds[0]);
    const d2 = this._findPlayer(this.debaterIds[1]);

    this.broadcast('host:phase', {
      phase: 'last_stand_intro',
      debater1: { id: d1.id, name: d1.name, color: d1.color },
      debater2: { id: d2.id, name: d2.name, color: d2.color },
      trueTopics: [p1.text, p2.text],
      timeLeft: T_LS_INTRO,
    });

    this.players.forEach(p => {
      const isDebater = this.debaterIds.includes(p.id);
      this.send(p.id, 'player:phase', {
        phase: 'last_stand_intro',
        role: isDebater ? 'debater' : 'audience',
        debater1Name: d1.name, debater1Color: d1.color,
        debater2Name: d2.name, debater2Color: d2.color,
      });
    });

    this.startTimer(T_LS_INTRO, () => this._beginLsPep());
  }

  _beginLsPep() {
    this.phase = 'last_stand_prep';
    const d1 = this._findPlayer(this.debaterIds[0]);
    const d2 = this._findPlayer(this.debaterIds[1]);

    this.broadcast('host:phase', {
      phase: 'last_stand_prep',
      debater1: { id: d1.id, name: d1.name, color: d1.color },
      debater2: { id: d2.id, name: d2.name, color: d2.color },
      timeLeft: T_LS_PREP,
    });

    this.players.forEach(p => {
      const isDebater = this.debaterIds.includes(p.id);
      if (isDebater) {
        const myPrompt = this.debaterPrompts[p.id];
        this.send(p.id, 'player:phase', {
          phase: 'last_stand_prep', role: 'debater',
          promptText: myPrompt.text,
          forbidden: this._lsForbidden,
          opponentName: isDebater ? (p.id === d1.id ? d2.name : d1.name) : null,
          timeLeft: T_LS_PREP,
        });
      } else {
        this.send(p.id, 'player:phase', {
          phase: 'last_stand_prep', role: 'audience',
          topic1: this.debaterPrompts[this.debaterIds[0]].text,
          topic2: this.debaterPrompts[this.debaterIds[1]].text,
          debater1Name: d1.name, debater2Name: d2.name,
          timeLeft: T_LS_PREP,
        });
      }
    });

    this.startTimer(T_LS_PREP, () => this._beginLsDebate());
  }

  _beginLsDebate() {
    this.phase = 'last_stand_debate';
    const d1 = this._findPlayer(this.debaterIds[0]);
    const d2 = this._findPlayer(this.debaterIds[1]);

    this.broadcast('host:phase', {
      phase: 'last_stand_debate',
      debater1: { id: d1.id, name: d1.name, color: d1.color },
      debater2: { id: d2.id, name: d2.name, color: d2.color },
      forbidden: this._lsForbidden,
      timeLeft: T_LS_DEBATE,
    });

    this.players.forEach(p => {
      const isDebater = this.debaterIds.includes(p.id);
      if (isDebater) {
        const myPrompt = this.debaterPrompts[p.id];
        this.send(p.id, 'player:phase', {
          phase: 'last_stand_debate', role: 'debater',
          promptText: myPrompt.text, forbidden: this._lsForbidden,
          timeLeft: T_LS_DEBATE,
        });
      } else {
        this.send(p.id, 'player:phase', {
          phase: 'last_stand_debate', role: 'audience',
          debater1Name: d1.name, debater1Color: d1.color,
          debater2Name: d2.name, debater2Color: d2.color,
          timeLeft: T_LS_DEBATE,
        });
      }
    });

    this.startTimer(T_LS_DEBATE, () => this._beginLsHeckle());
  }

  _beginLsHeckle() {
    this.phase = 'last_stand_heckle';
    const d1 = this._findPlayer(this.debaterIds[0]);
    const d2 = this._findPlayer(this.debaterIds[1]);
    const audienceSize = this.players.length - 2;

    this.broadcast('host:phase', {
      phase: 'last_stand_heckle',
      debater1Name: d1.name, debater2Name: d2.name,
      hecklesIn: 0, total: audienceSize,
      timeLeft: T_LS_HECKLE,
    });

    this.players.forEach(p => {
      const isDebater = this.debaterIds.includes(p.id);
      this.send(p.id, 'player:phase', {
        phase: 'last_stand_heckle',
        role: isDebater ? 'debater' : 'audience',
        timeLeft: T_LS_HECKLE,
      });
    });

    this.startTimer(T_LS_HECKLE, () => this._beginLsChallenge());
  }

  _beginLsChallenge() {
    this.phase = 'last_stand_challenge';
    const d1 = this._findPlayer(this.debaterIds[0]);
    const d2 = this._findPlayer(this.debaterIds[1]);
    const heckleList = [...this.lsHeckles.values()];

    this.broadcast('host:phase', {
      phase: 'last_stand_challenge',
      debater1: { id: d1.id, name: d1.name, color: d1.color },
      debater2: { id: d2.id, name: d2.name, color: d2.color },
      heckles: heckleList,
      forbidden: this._lsForbidden,
      timeLeft: T_LS_CHALLENGE,
    });

    this.players.forEach(p => {
      const isDebater = this.debaterIds.includes(p.id);
      const myPrompt = isDebater ? this.debaterPrompts[p.id] : null;
      this.send(p.id, 'player:phase', {
        phase: 'last_stand_challenge',
        role: isDebater ? 'debater' : 'audience',
        heckles: heckleList,
        promptText: myPrompt?.text ?? null,
        forbidden: this._lsForbidden,
        timeLeft: T_LS_CHALLENGE,
      });
    });

    this.startTimer(T_LS_CHALLENGE, () => this._beginLsVoting());
  }

  _beginLsVoting() {
    this.phase = 'last_stand_voting';
    const d1 = this._findPlayer(this.debaterIds[0]);
    const d2 = this._findPlayer(this.debaterIds[1]);
    const audienceSize = this.players.length - 2;

    this.broadcast('host:phase', {
      phase: 'last_stand_voting',
      debater1: { id: d1.id, name: d1.name, color: d1.color },
      debater2: { id: d2.id, name: d2.name, color: d2.color },
      voted: 0, total: audienceSize,
      timeLeft: T_LS_VOTING,
    });

    this.players.forEach(p => {
      const isDebater = this.debaterIds.includes(p.id);
      this.send(p.id, 'player:phase', {
        phase: 'last_stand_voting',
        role: isDebater ? 'waiting' : 'voter',
        debater1: { id: d1.id, name: d1.name, color: d1.color },
        debater2: { id: d2.id, name: d2.name, color: d2.color },
        timeLeft: T_LS_VOTING,
      });
    });

    this.startTimer(T_LS_VOTING, () => this._beginLsReveal());
  }

  _beginLsReveal() {
    this.phase = 'last_stand_reveal';
    this.clearTimer();

    const d1 = this._findPlayer(this.debaterIds[0]);
    const d2 = this._findPlayer(this.debaterIds[1]);

    // Tally winner
    const tally = new Map([[this.debaterIds[0], 0], [this.debaterIds[1], 0]]);
    for (const winnerId of this.lsVotes.values()) {
      tally.set(winnerId, (tally.get(winnerId) || 0) + 1);
    }
    const [v1, v2] = [tally.get(this.debaterIds[0]), tally.get(this.debaterIds[1])];
    const winnerId  = v1 >= v2 ? this.debaterIds[0] : this.debaterIds[1];
    const winner    = this._findPlayer(winnerId);
    if (winner) winner.score += LS_WIN_BONUS;

    for (const [pid, vote] of this.lsVotes) {
      if (vote === winnerId) {
        const p = this._findPlayer(pid);
        if (p) p.score += LS_VOTE_BONUS;
      }
    }

    const payload = {
      phase: 'last_stand_reveal',
      debater1: { id: d1.id, name: d1.name, color: d1.color, prompt: this.debaterPrompts[d1.id].text, votes: v1 },
      debater2: { id: d2.id, name: d2.name, color: d2.color, prompt: this.debaterPrompts[d2.id].text, votes: v2 },
      winnerId,
      players: this.players.map(p => ({ id: p.id, name: p.name, color: p.color, score: p.score })),
    };

    this.broadcast('host:phase', payload);
    this.players.forEach(p => {
      this.send(p.id, 'player:phase', {
        ...payload,
        myRole: this.debaterIds.includes(p.id) ? 'debater' : 'audience',
        iWon: p.id === winnerId,
        myScore: p.score,
        myVote: this.lsVotes.get(p.id) ?? null,
      });
    });

    this.startTimer(T_LS_REVEAL, () => this._afterReveal());
  }

  // ── End game ─────────────────────────────────────────────────

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

  // ── Helpers ──────────────────────────────────────────────────

  _speaker()           { return this.players[this.speakerIdx % this.players.length]; }
  _speakerId()         { return this._speaker().id; }
  _findPlayer(id)      { return this.players.find(p => p.id === id) ?? null; }
  _audienceSize()      { return this.players.length - 2; } // minus speaker + aide

  _reactionSummary() {
    const out = {};
    for (const [pid, r] of this.reactions) {
      out[pid] = { net: Math.max(-CHEER_CAP, Math.min(CHEER_CAP, r.cheers - r.boos)) };
    }
    return out;
  }

  _resetTurnState() {
    this.aideId         = null;
    this.truePrompt     = null;
    this.decoyPrompt    = null;
    this.speakerHasTrue = false;
    this.napkins        = [];
    this.reactions      = new Map();
    this.heckles        = new Map();
    this.votes          = new Map();
  }

  _resetLsState() {
    this.debaterIds    = [];
    this.debaterPrompts = {};
    this._lsForbidden  = [];
    this.lsVotes       = new Map();
    this.lsHeckles     = new Map();
    this.reactions     = new Map();
  }
}

module.exports = GslsGame;
