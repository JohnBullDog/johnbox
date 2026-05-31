/**
 * OverruledGame — "Overruled!"
 *
 * A courtroom game where the crime is absurd but the arguments are real.
 *
 * Roles (rotate each trial):
 *   Judge      — picks the crime, rules on objections
 *   Prosecutor — fabricates evidence (must be accepted as fact)
 *   Defendant  — responds to each piece starting with "But..."
 *   Jury       — cheer/boo live, vote Guilty / Not Guilty at the end
 *
 * Phase flow per trial:
 *   trial_setup → crime_reveal →
 *   [evidence_create → evidence_present → (objection_rule_present?) →
 *    evidence_respond → (objection_rule_respond?)] × 3 →
 *   closing_prosecution → closing_defence →
 *   verdict_vote → verdict_reveal → [next trial | game_over]
 *
 * Scoring:
 *   Prosecutor  +200 if Guilty verdict
 *   Defendant   +200 if Not Guilty verdict
 *   Judge/Jury  earn 0 from the verdict they are judging;
 *               score normally when they are Prosecutor/Defendant
 *
 * Minimum players: 4
 */

const BaseGame = require('./BaseGame');
const ALL_CRIMES = require('../../data/overruled_crimes.json');

const EVIDENCE_TYPES = [
  { id: 'text_message', label: '📱 Text Message',      input: 'text' },
  { id: 'witness',      label: '👁️ Witness Testimony', input: 'text' },
  { id: 'document',     label: '📄 Document',          input: 'text' },
  { id: 'cctv',         label: '📹 CCTV Footage',      input: 'text' },
  { id: 'drawing',      label: '🎨 Exhibit A',         input: 'draw' },
];

const SUSTAIN_GUIDELINES = [
  'Defendant denied the evidence outright instead of explaining it away',
  'Evidence directly contradicts something already established this trial',
  'Evidence is completely incoherent or self-contradicting',
];
const OVERRULE_GUIDELINES = [
  'Evidence is damaging but internally consistent (damaging ≠ invalid)',
  'All evidence is fabricated — that alone is not grounds for objection',
  'Objection appears to be tactical delay rather than a genuine challenge',
];

const T_SETUP           = 4;
const T_CRIME           = 20;
const T_CREATE_TEXT     = 60;
const T_CREATE_DRAW     = 90;
const T_PRESENT         = 40;
const T_RESPOND         = 40;
const T_OBJECTION_RULE  = 25;
const T_CLOSING         = 45;
const T_VOTE            = 25;
const T_REVEAL          = 10;
const CHEER_CAP         = 5;
const VERDICT_SCORE     = 200;

class OverruledGame extends BaseGame {
  constructor(roomCode, io) {
    super(roomCode, io);
    this.maxRounds   = 1;
    this.trialIdx    = 0;
    this.totalTrials = 0;

    this.judgeId      = null;
    this.prosecutorId = null;
    this.defendantId  = null;
    this.juryIds      = [];

    this.currentCrime     = null;
    this.crimeOptions     = [];
    this.usedCrimeIds     = new Set();

    this.evidenceRound    = 0;
    this.evidenceTypes    = [];
    this.evidenceContent  = null;
    this.evidenceHistory  = [];

    this.pendingObjection = null;   // { filerRole, phase }
    this.objectionResult  = null;   // 'sustained'|'overruled'|null

    this.reactions = new Map();
    this.juryVotes = new Map();
  }

  // ── Lifecycle ────────────────────────────────────────────────

  start(players, options = {}) {
    this.maxRounds   = Math.max(1, options.rounds ?? 1);
    this.players     = players.map(p => ({ ...p, score: 0 }));
    this.totalTrials = this.players.length * this.maxRounds;
    this._beginTrial();
  }

  advance() {
    this.clearTimer();
    switch (this.phase) {
      case 'trial_setup':              this._beginCrimeReveal();         break;
      case 'crime_reveal':
        if (!this.currentCrime) this.currentCrime = this.crimeOptions[0];
        this._beginEvidenceCreate();
        break;
      case 'evidence_create':          this._beginEvidencePresent();     break;
      case 'evidence_present':
        if (this.pendingObjection?.phase === 'present') this._beginObjectionRule('present');
        else this._beginEvidenceRespond();
        break;
      case 'objection_rule_present':
        if (this.objectionResult === 'sustained') this._endEvidenceRound();
        else this._beginEvidenceRespond();
        break;
      case 'evidence_respond':
        if (this.pendingObjection?.phase === 'respond') this._beginObjectionRule('respond');
        else this._endEvidenceRound();
        break;
      case 'objection_rule_respond':   this._endEvidenceRound();         break;
      case 'closing_prosecution':      this._beginClosingDefence();      break;
      case 'closing_defence':          this._beginVerdictVote();         break;
      case 'verdict_vote':             this._beginVerdictReveal();       break;
      case 'verdict_reveal':           this._afterVerdict();             break;
    }
  }

  handlePlayerAction(player, data) {
    switch (data.type) {

      case 'crime_selected': {
        if (player.id !== this.judgeId) break;
        if (this.phase !== 'crime_reveal') break;
        const crime = this.crimeOptions.find(c => c.id === data.crimeId);
        if (!crime) break;
        this.currentCrime = crime;
        this.clearTimer();
        this.broadcast('overruled:crime_confirmed', { crime });
        this._beginEvidenceCreate();
        break;
      }

      case 'evidence_draw': {
        if (player.id !== this.prosecutorId) break;
        if (this.phase !== 'evidence_create') break;
        this.broadcast('overruled:draw', { event: data.event });
        break;
      }

      case 'evidence_submitted': {
        if (player.id !== this.prosecutorId) break;
        if (this.phase !== 'evidence_create') break;
        const evType = this.evidenceTypes[this.evidenceRound];
        this.evidenceContent = {
          type: evType.id,
          label: evType.label,
          text: data.text ?? null,
          imageData: data.imageData ?? null,
        };
        this.clearTimer();
        this._beginEvidencePresent();
        break;
      }

      case 'speaker_done': {
        const speakerPhases = ['evidence_present', 'evidence_respond', 'closing_prosecution', 'closing_defence'];
        if (!speakerPhases.includes(this.phase)) break;
        const speakerId =
          this.phase === 'evidence_present'    ? this.prosecutorId :
          this.phase === 'evidence_respond'    ? this.defendantId  :
          this.phase === 'closing_prosecution' ? this.prosecutorId :
          this.phase === 'closing_defence'     ? this.defendantId  : null;
        if (player.id !== speakerId) break;
        this.clearTimer();
        this.advance();
        break;
      }

      case 'objection': {
        if (!['evidence_present', 'evidence_respond'].includes(this.phase)) break;
        if (this.pendingObjection) break;  // only first objection counts
        const isPresent = this.phase === 'evidence_present';
        const validFiler = isPresent ? this.defendantId : this.prosecutorId;
        if (player.id !== validFiler) break;
        const filerRole = isPresent ? 'defendant' : 'prosecutor';
        this.pendingObjection = { filerRole, phase: isPresent ? 'present' : 'respond' };
        this.broadcast('overruled:objection_filed', {
          filerRole,
          filerName: this._findPlayer(player.id)?.name,
          phase: this.pendingObjection.phase,
        });
        break;
      }

      case 'objection_ruling': {
        if (player.id !== this.judgeId) break;
        if (!['objection_rule_present', 'objection_rule_respond'].includes(this.phase)) break;
        const ruling = data.ruling === 'sustained' ? 'sustained' : 'overruled';
        this.objectionResult = ruling;
        this.broadcast('overruled:ruling', { ruling });
        this.clearTimer();
        setTimeout(() => this.advance(), 1500);
        break;
      }

      case 'cheer':
      case 'boo': {
        const reactPhases = ['evidence_present','evidence_respond','closing_prosecution','closing_defence'];
        if (!reactPhases.includes(this.phase)) break;
        if (!this.juryIds.includes(player.id)) break;
        if (!this.reactions.has(player.id)) this.reactions.set(player.id, { cheers: 0, boos: 0 });
        const r = this.reactions.get(player.id);
        if (data.type === 'cheer') r.cheers++; else r.boos++;
        this.broadcast('overruled:reaction_update', { net: this._totalNet() });
        break;
      }

      case 'verdict_vote': {
        if (this.phase !== 'verdict_vote') break;
        if (!this.juryIds.includes(player.id)) break;
        if (this.juryVotes.has(player.id)) break;
        if (!['guilty', 'not_guilty'].includes(data.vote)) break;
        this.juryVotes.set(player.id, data.vote);
        this.broadcast('overruled:vote_count', { voted: this.juryVotes.size, total: this.juryIds.length });
        if (this.juryVotes.size >= this.juryIds.length) { this.clearTimer(); this._beginVerdictReveal(); }
        break;
      }
    }
  }

  // ── Trial phases ─────────────────────────────────────────────

  _beginTrial() {
    this._assignRoles();
    this._resetTrialState();
    this.phase = 'trial_setup';

    const judge     = this._findPlayer(this.judgeId);
    const prosecutor = this._findPlayer(this.prosecutorId);
    const defendant  = this._findPlayer(this.defendantId);
    const jury       = this.juryIds.map(id => this._findPlayer(id)).filter(Boolean);

    this.broadcast('host:phase', {
      phase: 'trial_setup', game: 'overruled',
      trialNumber: this.trialIdx + 1, totalTrials: this.totalTrials,
      judge: this._pub(judge), prosecutor: this._pub(prosecutor),
      defendant: this._pub(defendant), jury: jury.map(p => this._pub(p)),
    });

    this.players.forEach(p => {
      const role = this._roleOf(p.id);
      this.send(p.id, 'player:phase', {
        phase: 'trial_setup', game: 'overruled', role,
        trialNumber: this.trialIdx + 1, totalTrials: this.totalTrials,
        judgeName: judge?.name, judgeColor: judge?.color,
        prosecutorName: prosecutor?.name, prosecutorColor: prosecutor?.color,
        defendantName: defendant?.name, defendantColor: defendant?.color,
      });
    });

    this.startTimer(T_SETUP, () => this._beginCrimeReveal());
  }

  _beginCrimeReveal() {
    this.phase = 'crime_reveal';
    const pool = ALL_CRIMES.filter(c => !this.usedCrimeIds.has(c.id));
    const src  = pool.length >= 3 ? pool : ALL_CRIMES;
    this.crimeOptions = this._shuffle([...src]).slice(0, 3);

    const judge = this._findPlayer(this.judgeId);
    this.broadcast('host:phase', {
      phase: 'crime_reveal', game: 'overruled',
      judgeName: judge?.name, judgeColor: judge?.color,
    });

    this.players.forEach(p => {
      const role = this._roleOf(p.id);
      this.send(p.id, 'player:phase', {
        phase: 'crime_reveal', game: 'overruled', role,
        ...(role === 'judge' ? { crimeOptions: this.crimeOptions } : {}),
        judgeName: judge?.name,
        timeLeft: T_CRIME,
      });
    });

    this.startTimer(T_CRIME, () => {
      if (!this.currentCrime) this.currentCrime = this.crimeOptions[0];
      this._beginEvidenceCreate();
    });
  }

  _beginEvidenceCreate() {
    this.phase = 'evidence_create';
    this.pendingObjection = null;
    this.objectionResult  = null;
    this.evidenceContent  = null;

    const evType   = this.evidenceTypes[this.evidenceRound];
    const prosecutor = this._findPlayer(this.prosecutorId);
    const defendant  = this._findPlayer(this.defendantId);
    const timer      = evType.input === 'draw' ? T_CREATE_DRAW : T_CREATE_TEXT;

    this.broadcast('host:phase', {
      phase: 'evidence_create', game: 'overruled',
      evidenceRound: this.evidenceRound + 1,
      evidenceType: evType,
      crime: this.currentCrime,
      prosecutorName: prosecutor?.name, prosecutorColor: prosecutor?.color,
    });

    this.players.forEach(p => {
      const role = this._roleOf(p.id);
      this.send(p.id, 'player:phase', {
        phase: 'evidence_create', game: 'overruled', role,
        evidenceRound: this.evidenceRound + 1,
        evidenceType: evType,
        crime: this.currentCrime,
        timeLeft: timer,
      });
    });

    this.startTimer(timer, () => this._beginEvidencePresent());
  }

  _beginEvidencePresent() {
    this.phase = 'evidence_present';
    const ev         = this.evidenceContent ?? { type: 'document', label: '📄 Document', text: '[No evidence submitted]' };
    const prosecutor = this._findPlayer(this.prosecutorId);
    const defendant  = this._findPlayer(this.defendantId);

    this.broadcast('host:phase', {
      phase: 'evidence_present', game: 'overruled',
      evidenceRound: this.evidenceRound + 1,
      evidence: ev, crime: this.currentCrime,
      prosecutorName: prosecutor?.name, prosecutorColor: prosecutor?.color,
      defendantName: defendant?.name, defendantColor: defendant?.color,
      timeLeft: T_PRESENT,
    });

    this.players.forEach(p => {
      const role = this._roleOf(p.id);
      this.send(p.id, 'player:phase', {
        phase: 'evidence_present', game: 'overruled', role,
        evidence: ev, crime: this.currentCrime,
        evidenceRound: this.evidenceRound + 1,
        prosecutorName: prosecutor?.name, defendantName: defendant?.name,
        timeLeft: T_PRESENT,
      });
    });

    this.startTimer(T_PRESENT, () => this.advance());
  }

  _beginObjectionRule(ofPhase) {
    this.phase = ofPhase === 'present' ? 'objection_rule_present' : 'objection_rule_respond';
    const judge = this._findPlayer(this.judgeId);
    const filer = this._findPlayer(
      this.pendingObjection.filerRole === 'prosecutor' ? this.prosecutorId : this.defendantId
    );

    this.broadcast('host:phase', {
      phase: this.phase, game: 'overruled',
      objection: this.pendingObjection,
      filerName: filer?.name, filerColor: filer?.color,
      judgeName: judge?.name, judgeColor: judge?.color,
      sustainGuidelines: SUSTAIN_GUIDELINES,
      overruleGuidelines: OVERRULE_GUIDELINES,
      timeLeft: T_OBJECTION_RULE,
    });

    this.players.forEach(p => {
      const role = this._roleOf(p.id);
      this.send(p.id, 'player:phase', {
        phase: this.phase, game: 'overruled', role,
        objection: this.pendingObjection,
        filerName: filer?.name,
        judgeName: judge?.name,
        ...(role === 'judge' ? { sustainGuidelines: SUSTAIN_GUIDELINES, overruleGuidelines: OVERRULE_GUIDELINES } : {}),
        timeLeft: T_OBJECTION_RULE,
      });
    });

    this.startTimer(T_OBJECTION_RULE, () => {
      if (!this.objectionResult) this.objectionResult = 'overruled';
      this.advance();
    });
  }

  _beginEvidenceRespond() {
    this.phase = 'evidence_respond';
    const ev         = this.evidenceContent ?? { type: 'document', label: '📄', text: '' };
    const defendant  = this._findPlayer(this.defendantId);
    const prosecutor = this._findPlayer(this.prosecutorId);

    this.broadcast('host:phase', {
      phase: 'evidence_respond', game: 'overruled',
      evidenceRound: this.evidenceRound + 1,
      evidence: ev, crime: this.currentCrime,
      defendantName: defendant?.name, defendantColor: defendant?.color,
      prosecutorName: prosecutor?.name,
      timeLeft: T_RESPOND,
    });

    this.players.forEach(p => {
      const role = this._roleOf(p.id);
      this.send(p.id, 'player:phase', {
        phase: 'evidence_respond', game: 'overruled', role,
        evidence: ev, crime: this.currentCrime,
        evidenceRound: this.evidenceRound + 1,
        defendantName: defendant?.name, prosecutorName: prosecutor?.name,
        timeLeft: T_RESPOND,
      });
    });

    this.startTimer(T_RESPOND, () => this.advance());
  }

  _endEvidenceRound() {
    if (this.evidenceContent) {
      this.evidenceHistory.push({
        ...this.evidenceContent,
        round: this.evidenceRound + 1,
        voided: this.objectionResult === 'sustained' && this.pendingObjection?.phase === 'present',
      });
    }
    this.evidenceRound++;
    if (this.evidenceRound >= 3) {
      this._beginClosingProsecution();
    } else {
      this._beginEvidenceCreate();
    }
  }

  _beginClosingProsecution() {
    this.phase = 'closing_prosecution';
    const prosecutor = this._findPlayer(this.prosecutorId);
    const defendant  = this._findPlayer(this.defendantId);

    this.broadcast('host:phase', {
      phase: 'closing_prosecution', game: 'overruled',
      crime: this.currentCrime,
      prosecutorName: prosecutor?.name, prosecutorColor: prosecutor?.color,
      defendantName: defendant?.name,
      evidenceHistory: this.evidenceHistory,
      timeLeft: T_CLOSING,
    });

    this.players.forEach(p => {
      this.send(p.id, 'player:phase', {
        phase: 'closing_prosecution', game: 'overruled',
        role: this._roleOf(p.id),
        prosecutorName: prosecutor?.name, defendantName: defendant?.name,
        timeLeft: T_CLOSING,
      });
    });

    this.startTimer(T_CLOSING, () => this._beginClosingDefence());
  }

  _beginClosingDefence() {
    this.phase = 'closing_defence';
    const defendant  = this._findPlayer(this.defendantId);
    const prosecutor = this._findPlayer(this.prosecutorId);

    this.broadcast('host:phase', {
      phase: 'closing_defence', game: 'overruled',
      crime: this.currentCrime,
      defendantName: defendant?.name, defendantColor: defendant?.color,
      prosecutorName: prosecutor?.name,
      timeLeft: T_CLOSING,
    });

    this.players.forEach(p => {
      this.send(p.id, 'player:phase', {
        phase: 'closing_defence', game: 'overruled',
        role: this._roleOf(p.id),
        defendantName: defendant?.name, prosecutorName: prosecutor?.name,
        timeLeft: T_CLOSING,
      });
    });

    this.startTimer(T_CLOSING, () => this._beginVerdictVote());
  }

  _beginVerdictVote() {
    this.phase = 'verdict_vote';
    const defendant = this._findPlayer(this.defendantId);

    this.broadcast('host:phase', {
      phase: 'verdict_vote', game: 'overruled',
      crime: this.currentCrime,
      defendantName: defendant?.name, defendantColor: defendant?.color,
      voted: 0, total: this.juryIds.length,
      timeLeft: T_VOTE,
    });

    this.players.forEach(p => {
      const role = this._roleOf(p.id);
      this.send(p.id, 'player:phase', {
        phase: 'verdict_vote', game: 'overruled', role,
        defendantName: defendant?.name,
        timeLeft: T_VOTE,
      });
    });

    this.startTimer(T_VOTE, () => this._beginVerdictReveal());
  }

  _beginVerdictReveal() {
    this.phase = 'verdict_reveal';
    this.clearTimer();

    const guiltyVotes    = [...this.juryVotes.values()].filter(v => v === 'guilty').length;
    const notGuiltyVotes = this.juryVotes.size - guiltyVotes;
    const isGuilty       = guiltyVotes >= Math.ceil(this.juryIds.length / 2);

    const prosecutor = this._findPlayer(this.prosecutorId);
    const defendant  = this._findPlayer(this.defendantId);

    if (isGuilty && prosecutor) prosecutor.score += VERDICT_SCORE;
    if (!isGuilty && defendant)  defendant.score  += VERDICT_SCORE;

    const payload = {
      phase: 'verdict_reveal', game: 'overruled',
      crime: this.currentCrime,
      isGuilty,
      guiltyVotes, notGuiltyVotes,
      prosecutorName: prosecutor?.name, prosecutorColor: prosecutor?.color,
      defendantName: defendant?.name,   defendantColor: defendant?.color,
      players: this.players.map(p => ({ id: p.id, name: p.name, color: p.color, score: p.score })),
    };

    this.broadcast('host:phase', payload);
    this.players.forEach(p => {
      const role = this._roleOf(p.id);
      const scoreDelta =
        (role === 'prosecutor' && isGuilty)  ? VERDICT_SCORE :
        (role === 'defendant'  && !isGuilty) ? VERDICT_SCORE : 0;
      this.send(p.id, 'player:phase', { ...payload, role, scoreDelta });
    });

    this.startTimer(T_REVEAL, () => this._afterVerdict());
  }

  _afterVerdict() {
    this.trialIdx++;
    if (this.trialIdx >= this.totalTrials) {
      this._endGame();
    } else {
      this._beginTrial();
    }
  }

  _endGame() {
    this.phase = 'game_over';
    this.clearTimer();
    const sorted = [...this.players].sort((a, b) => b.score - a.score);
    const payload = {
      phase: 'game_over', game: 'overruled',
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

  _assignRoles() {
    const n = this.players.length;
    this.defendantId  = this.players[this.trialIdx % n].id;
    this.prosecutorId = this.players[(this.trialIdx + 1) % n].id;
    this.judgeId      = this.players[(this.trialIdx + 2) % n].id;
    this.juryIds      = this.players
      .map(p => p.id)
      .filter(id => id !== this.defendantId && id !== this.prosecutorId && id !== this.judgeId);
  }

  _resetTrialState() {
    this.currentCrime     = null;
    this.crimeOptions     = [];
    this.evidenceRound    = 0;
    this.evidenceTypes    = this._pickEvidenceTypes();
    this.evidenceContent  = null;
    this.evidenceHistory  = [];
    this.pendingObjection = null;
    this.objectionResult  = null;
    this.reactions        = new Map();
    this.juryVotes        = new Map();
  }

  _pickEvidenceTypes() {
    return this._shuffle([...EVIDENCE_TYPES]).slice(0, 3);
  }

  _roleOf(id) {
    if (id === this.judgeId)      return 'judge';
    if (id === this.prosecutorId) return 'prosecutor';
    if (id === this.defendantId)  return 'defendant';
    return 'jury';
  }

  _pub(p) {
    if (!p) return null;
    return { id: p.id, name: p.name, color: p.color };
  }

  _findPlayer(id)  { return this.players.find(p => p.id === id) ?? null; }

  _totalNet() {
    let net = 0;
    for (const r of this.reactions.values()) {
      net += Math.max(-CHEER_CAP, Math.min(CHEER_CAP, r.cheers - r.boos));
    }
    return net;
  }

  _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

module.exports = OverruledGame;
