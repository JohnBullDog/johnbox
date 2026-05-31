'use strict';

const socket = io();

// ── State ──────────────────────────────────────────────────
let roomCode      = null;
let currentPhase  = null;
let timerMax      = 60;

const gameSettings = { rounds: 3 };
const SETTING_LIMITS = { rounds: [1, 10] };

function adjustSetting(key, delta) {
  const [min, max] = SETTING_LIMITS[key];
  gameSettings[key] = Math.max(min, Math.min(max, gameSettings[key] + delta));
  document.getElementById(`setting-${key}`).textContent = gameSettings[key];
}

// We maintain ONE shared ImageData across phase canvases so the drawing
// persists when we copy it to the voting/results canvas.
let drawingSnapshot = null;

// ── Canvas helpers ─────────────────────────────────────────

function getCanvas(id) {
  const c = document.getElementById(id);
  if (!c._sized) {
    const r = c.parentElement.getBoundingClientRect();
    c.width  = r.width  || 800;
    c.height = r.height || 600;
    c._sized = true;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, c.width, c.height);
  }
  return c;
}

function resizeAll() {
  ['host-canvas','host-canvas-guess','host-canvas-vote','host-canvas-results']
    .forEach(id => {
      const c = document.getElementById(id);
      c._sized = false;
    });
}
window.addEventListener('resize', resizeAll);

function normalDraw(ctx, ev) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (ev.type === 'line') {
    ctx.beginPath();
    ctx.moveTo(ev.x0 * w, ev.y0 * h);
    ctx.lineTo(ev.x1 * w, ev.y1 * h);
    ctx.strokeStyle = ev.color;
    ctx.lineWidth   = ev.size;
    ctx.stroke();
  } else if (ev.type === 'dot') {
    ctx.beginPath();
    ctx.arc(ev.x * w, ev.y * h, ev.size / 2, 0, Math.PI * 2);
    ctx.fillStyle = ev.color;
    ctx.fill();
  } else if (ev.type === 'clear') {
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }
}

function copyToCanvas(srcId, dstId) {
  const src = getCanvas(srcId);
  const dst = getCanvas(dstId);
  dst.width  = dst.parentElement.getBoundingClientRect().width  || 800;
  dst.height = dst.parentElement.getBoundingClientRect().height || 600;
  const dctx = dst.getContext('2d');
  dctx.drawImage(src, 0, 0, dst.width, dst.height);
}

// ── Screen / panel helpers ─────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showPhasePanel(id) {
  document.querySelectorAll('.phase-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── Timer UI ───────────────────────────────────────────────

function updateTimer(timeLeft) {
  document.getElementById('timer-num').textContent = timeLeft;
  const circle = document.getElementById('timer-circle');
  const pct    = timerMax > 0 ? timeLeft / timerMax : 0;
  circle.style.strokeDashoffset = 113 * (1 - pct);

  // Phase-specific progress bars
  ['draw-timer-bar', 'guess-timer-bar', 'vote-timer-bar'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.width = (pct * 100) + '%';
  });
}

// ── Lobby ──────────────────────────────────────────────────

function createRoom() {
  const gameType = document.getElementById('game-type-select').value;
  socket.emit('room:create', { gameType });
}

function startGame() {
  socket.emit('game:start', { rounds: gameSettings.rounds });
}

function skipPhase() {
  socket.emit('game:next');
}

socket.on('room:created', async ({ code }) => {
  roomCode = code;
  document.getElementById('lobby-code').textContent = code;

  // Use ngrok/public URL if the server knows one, otherwise fall back to current origin
  let base = location.origin;
  try {
    const res  = await fetch('/api/public-url');
    const data = await res.json();
    if (data.url) base = data.url;
  } catch { /* ignore — localhost fallback is fine */ }

  const joinUrl = `${base}/play?code=${code}`;
  document.getElementById('lobby-url').textContent = joinUrl;

  const qrEl = document.getElementById('qr-code');
  qrEl.innerHTML = '';
  try {
    new QRCode(qrEl, { text: joinUrl, width: 160, height: 160 });
  } catch (e) { /* QRCode library unavailable offline */ }

  showScreen('s-lobby');
});

socket.on('lobby:update', ({ players }) => {
  const list = document.getElementById('player-list');
  if (players.length === 0) {
    list.innerHTML = '<p class="empty-lobby">Waiting for players…</p>';
    document.getElementById('btn-start').disabled = true;
    return;
  }
  list.innerHTML = players.map(p => `
    <div class="player-chip">
      <div class="player-dot" style="background:${p.color}"></div>
      ${esc(p.name)}
    </div>
  `).join('');
  document.getElementById('btn-start').disabled = players.length < 2;
});

// ── Game phases ────────────────────────────────────────────

socket.on('host:phase', (data) => {
  if (data.game === 'gsls' || data.game === 'overruled') return;  // handled by GSLS listener below
  currentPhase = data.phase;
  showScreen('s-game');

  switch (data.phase) {
    case 'round_intro':   handleRoundIntro(data);   break;
    case 'drawing':       handleDrawing(data);       break;
    case 'guessing':      handleGuessing(data);      break;
    case 'voting':        handleVoting(data);        break;
    case 'round_results': handleResults(data);       break;
    case 'game_over':     handleGameOver(data);      break;
  }
});

socket.on('timer', ({ timeLeft }) => {
  updateTimer(timeLeft);
});

socket.on('host:draw', ({ event }) => {
  const c = getCanvas('host-canvas');
  normalDraw(c.getContext('2d'), event);
});

socket.on('host:guesses_up', ({ guessesIn, total }) => {
  document.getElementById('guess-count').textContent = `${guessesIn}/${total}`;
  renderGuesserStatus(guessesIn, total);
});

socket.on('host:votes_up', ({ votesIn, total }) => {
  document.getElementById('vote-count').textContent = `${votesIn}/${total} voted`;
});

// ── Phase handlers ─────────────────────────────────────────

function handleRoundIntro(d) {
  showPhasePanel('p-round-intro');
  timerMax = 5;
  document.getElementById('hdr-round').textContent  = `Round ${d.round}/${d.maxRounds}`;
  document.getElementById('hdr-phase').textContent  = 'Get Ready';
  document.getElementById('intro-round-num').textContent  = d.round;
  document.getElementById('intro-max-rounds').textContent = d.maxRounds;
  const chip = document.getElementById('intro-drawer-chip');
  chip.textContent       = d.drawerName;
  chip.style.background  = d.drawerColor;
  chip.style.color       = '#000';
}

function handleDrawing(d) {
  showPhasePanel('p-drawing');
  timerMax = d.timeLeft;
  document.getElementById('hdr-phase').textContent = 'Drawing…';

  const chip = document.getElementById('drawing-drawer-chip');
  chip.innerHTML = `<span style="width:10px;height:10px;border-radius:50%;background:${d.drawerColor};display:inline-block;"></span> ${esc(d.drawerName)}`;

  // Clear canvas for this round
  const c = getCanvas('host-canvas');
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, c.width, c.height);
}

function handleGuessing(d) {
  showPhasePanel('p-guessing');
  timerMax = d.timeLeft;
  document.getElementById('hdr-phase').textContent = 'Players Guessing';
  document.getElementById('guess-count').textContent = `${d.guessesIn}/${d.total}`;
  copyToCanvas('host-canvas', 'host-canvas-guess');
}

function handleVoting(d) {
  showPhasePanel('p-voting');
  timerMax = d.timeLeft;
  document.getElementById('hdr-phase').textContent = 'Voting';
  document.getElementById('vote-count').textContent = `${d.votesIn}/${d.total} voted`;
  copyToCanvas('host-canvas', 'host-canvas-vote');

  const list = document.getElementById('vote-options-list');
  list.innerHTML = d.answers.map((ans, i) => `
    <div class="vote-option" id="vote-opt-${i}">
      <span>${esc(ans)}</span>
      <span class="vote-count" id="vc-${i}">0</span>
    </div>
  `).join('');

  // Store mapping for vote count updates
  window._voteAnswers = d.answers;
}

function handleResults(d) {
  showPhasePanel('p-results');
  timerMax = 10;
  document.getElementById('hdr-phase').textContent = 'Results';
  document.getElementById('results-real-answer').textContent = d.realPrompt.toUpperCase();
  copyToCanvas('host-canvas', 'host-canvas-results');

  const answerList = document.getElementById('results-answer-list');
  answerList.innerHTML = d.answerDetails.map(item => {
    const votersText = item.voters.length
      ? `✓ ${item.voters.join(', ')} guessed this`
      : item.isReal ? '✗ Nobody guessed correctly' : '✗ Nobody was fooled';
    const subText = item.isReal
      ? '✅ Real Answer'
      : `🎭 ${item.submitterName ? 'by ' + esc(item.submitterName) : 'Nobody submitted this'}`;
    return `
      <div class="answer-reveal-item ${item.isReal ? 'is-real' : ''}">
        <div class="ans-text">${esc(item.ans)}</div>
        <div class="ans-meta">${subText} · ${votersText}</div>
      </div>
    `;
  }).join('');

  const scoreEl = document.getElementById('results-scores');
  scoreEl.innerHTML = d.players.map(p => `
    <div class="score-row">
      <div class="player-dot" style="background:${p.color}"></div>
      <div class="score-name">${esc(p.name)}</div>
      ${p.delta > 0 ? `<div class="score-delta">+${p.delta}</div>` : ''}
      <div class="score-total">${p.score}</div>
    </div>
  `).join('');
}

function handleGameOver(d) {
  showPhasePanel('p-gameover');
  document.getElementById('hdr-phase').textContent = 'Game Over';

  const top3 = d.players.slice(0, 3);
  const heights   = [200, 160, 120];
  const medalColors = ['#FFD700', '#C0C0C0', '#CD7F32'];
  const order = top3.length >= 3 ? [1, 0, 2] : [0, 1, 2]; // 2nd, 1st, 3rd for podium effect

  const podium = document.getElementById('podium');
  podium.innerHTML = order
    .filter(i => top3[i])
    .map(i => {
      const p = top3[i];
      return `
        <div class="podium-slot">
          <div class="podium-name">${esc(p.name)}</div>
          <div class="podium-score">${p.score} pts</div>
          <div class="podium-block" style="height:${heights[i]}px;background:${medalColors[i]};color:#000;">
            ${i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉'}
          </div>
        </div>
      `;
    }).join('');

  const finalList = document.getElementById('final-list');
  finalList.innerHTML = d.players.map(p => `
    <div class="final-row">
      <div class="final-rank">${p.rank}</div>
      <div class="player-dot" style="background:${p.color}"></div>
      <div class="final-name">${esc(p.name)}</div>
      <div class="final-score">${p.score} pts</div>
    </div>
  `).join('');
}

// ── Utility ────────────────────────────────────────────────

function renderGuesserStatus(guessesIn, total) {
  const el = document.getElementById('guess-player-list');
  if (!el) return;
  // Show placeholder dots for guesses received
  el.innerHTML = Array.from({ length: total }, (_, i) => `
    <div class="score-row">
      <div class="player-dot" style="background:${i < guessesIn ? '#4ecdc4' : '#333'}"></div>
      <div class="score-name">${i < guessesIn ? 'Answer in ✓' : 'Thinking…'}</div>
    </div>
  `).join('');
}

function esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

socket.on('error', ({ message }) => {
  alert(`Error: ${message}`);
});

socket.on('room:closed', ({ message }) => {
  alert(message);
  location.reload();
});

// ═══════════════════════════════════════════════════════════
// TAG GAME — host handlers
// ═══════════════════════════════════════════════════════════

let tgWheelSegments   = null;
let tgWheelRotation   = 0;   // current resting rotation in degrees
let tgWheelAnimFrame  = null;

// ── Wheel drawing ──────────────────────────────────────────

// Vivid alternating colours for adjective segments
const TG_SEG_COLORS = [
  '#1d4ed8','#15803d','#9333ea','#b45309',
  '#0e7490','#be185d','#dc2626','#0369a1',
];
const TG_EVENT_COLOR = '#d97706';

function tgWrapText(ctx, text, maxWidth, maxLines) {
  const words  = text.split(' ');
  const result = [];
  let   line   = '';
  for (let i = 0; i < words.length; i++) {
    const test = line ? line + ' ' + words[i] : words[i];
    if (ctx.measureText(test).width > maxWidth && line) {
      result.push(line);
      if (result.length >= maxLines) {
        // Truncate last line with ellipsis
        let last = result[result.length - 1];
        while (ctx.measureText(last + '…').width > maxWidth && last.includes(' '))
          last = last.slice(0, last.lastIndexOf(' '));
        result[result.length - 1] = last + '…';
        return result;
      }
      line = words[i];
    } else {
      line = test;
    }
  }
  if (line) result.push(line);
  return result.slice(0, maxLines);
}

function tgDrawWheel(canvas, segments, rotationDeg) {
  if (!canvas || !segments?.length) return;
  const ctx  = canvas.getContext('2d');
  const cx   = canvas.width  / 2;
  const cy   = canvas.height / 2;
  const r    = Math.min(cx, cy) - 8;
  const n    = segments.length;
  const arc  = (2 * Math.PI) / n;
  const off  = (rotationDeg * Math.PI / 180) - Math.PI / 2;
  const fs   = Math.max(11, Math.min(16, r * 0.075));   // font size scales with wheel
  const textR = r * 0.62;
  const maxW  = r * 0.52;   // max text width per line

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  segments.forEach((seg, i) => {
    const a0 = off + i * arc;
    const a1 = a0 + arc;

    // Segment fill
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a0, a1);
    ctx.closePath();
    ctx.fillStyle = seg.type === 'event' ? TG_EVENT_COLOR : TG_SEG_COLORS[i % TG_SEG_COLORS.length];
    ctx.fill();

    // Divider lines
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Text — flip rotation for bottom-half segments so text is never upside-down
    const mid        = a0 + arc / 2;
    const bottomHalf = Math.sin(mid) > 0;
    const textAngle  = bottomHalf ? mid - Math.PI / 2 : mid + Math.PI / 2;

    ctx.save();
    ctx.translate(cx + Math.cos(mid) * textR, cy + Math.sin(mid) * textR);
    ctx.rotate(textAngle);
    ctx.textAlign = 'center';
    ctx.font = `bold ${fs}px sans-serif`;

    const label = seg.type === 'event' ? `${seg.icon} ${seg.name}` : seg.value;
    const lines = tgWrapText(ctx, label, maxW, 2);

    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur  = 4;
    ctx.fillStyle   = 'white';

    const lineH  = fs * 1.3;
    const startY = -(lines.length - 1) * lineH / 2;
    lines.forEach((ln, li) => ctx.fillText(ln, 0, startY + li * lineH));

    ctx.restore();
  });

  ctx.shadowBlur = 0;

  // White inner ring + purple outer rim
  ctx.beginPath();
  ctx.arc(cx, cy, r + 1, 0, 2 * Math.PI);
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, r + 5, 0, 2 * Math.PI);
  ctx.strokeStyle = '#7c4dff';
  ctx.lineWidth = 5;
  ctx.stroke();

  // Centre hub
  const hubR = Math.max(14, r * 0.07);
  ctx.beginPath();
  ctx.arc(cx, cy, hubR, 0, 2 * Math.PI);
  ctx.fillStyle = '#0f0f1a';
  ctx.fill();
  ctx.strokeStyle = '#7c4dff';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function tgAnimateSpin(canvas, segments, fromDeg, resultIndex, onDone) {
  if (tgWheelAnimFrame) cancelAnimationFrame(tgWheelAnimFrame);
  const n          = segments.length;
  const segDeg     = 360 / n;
  const segCenter  = resultIndex * segDeg + segDeg / 2;
  const adjustment = (360 - segCenter + 360) % 360;
  const targetDeg  = fromDeg + 5 * 360 + adjustment;
  const duration   = 4500;
  const start      = performance.now();

  function frame(now) {
    const t     = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 5);
    const deg   = fromDeg + (targetDeg - fromDeg) * eased;
    tgDrawWheel(canvas, segments, deg);
    if (t < 1) {
      tgWheelAnimFrame = requestAnimationFrame(frame);
    } else {
      tgWheelRotation = targetDeg % 360;
      if (onDone) onDone();
    }
  }
  tgWheelAnimFrame = requestAnimationFrame(frame);
}

// Copy wheel drawing to another canvas element (for persistent display)
function tgCopyWheel(fromId, toId) {
  const src = document.getElementById(fromId);
  const dst = document.getElementById(toId);
  if (!src || !dst) return;
  const ctx = dst.getContext('2d');
  ctx.clearRect(0, 0, dst.width, dst.height);
  ctx.drawImage(src, 0, 0, dst.width, dst.height);
}

// ── Phase handlers ─────────────────────────────────────────

socket.on('host:phase', (data) => {
  if (data.game === 'gsls' || data.game === 'overruled') return;
  // TagGame phases
  switch (data.phase) {
    case 'spin_ready':    tgHandleSpinReady(data);    return;
    case 'spinning':      tgHandleSpinning(data);     return;
    case 'adj_result':    tgHandleAdjResult(data);    return;
    case 'event_result':  tgHandleEventResult(data);  return;
    case 'event_resolve': tgHandleEventResolve(data); return;
    case 'event_applied': tgHandleEventApplied(data); return;
    case 'task_intro':       tgHandleTaskIntro(data);   return;
    case 'skit':             tgHandleSkit(data);        return;
    case 'performance_vote': tgHandlePerfVote(data);    return;
    case 'skit_result':      tgHandleSkitResult(data);  return;
    case 'game_over':
      if (data.players?.[0]?.tags !== undefined) { tgHandleGameOver(data); return; }
      break;
  }
  // SketchMatch phases
  currentPhase = data.phase;
  showScreen('s-game');
  switch (data.phase) {
    case 'round_intro':   handleRoundIntro(data);   break;
    case 'drawing':       handleDrawing(data);       break;
    case 'guessing':      handleGuessing(data);      break;
    case 'voting':        handleVoting(data);        break;
    case 'round_results': handleResults(data);       break;
    case 'game_over':     handleGameOver(data);      break;
  }
});

function tgHandleSpinReady(d) {
  tgWheelSegments = d.wheelSegments;
  showScreen('s-game');
  showPhasePanel('p-tg-spin-ready');
  timerMax = 999;
  document.getElementById('hdr-round').textContent = `Round ${d.roundNumber}/${d.maxRounds}`;
  document.getElementById('hdr-phase').textContent = `Turn ${d.turnInRound}/${d.playersPerRound}`;

  const chip = document.getElementById('tg-sr-spinner');
  chip.textContent       = `${d.spinner.name} is spinning`;
  chip.style.background  = d.spinner.color + '44';
  chip.style.borderLeft  = `4px solid ${d.spinner.color}`;

  tgDrawWheel(document.getElementById('tg-host-wheel'), d.wheelSegments, tgWheelRotation);
  tgRenderPlayerTags('tg-sr-players', d.allPlayers);
}

function tgHandleSpinning(d) {
  tgWheelSegments = d.wheelSegments;
  showPhasePanel('p-tg-spinning');
  document.getElementById('hdr-phase').textContent = 'Spinning!';

  const chip = document.getElementById('tg-sp-spinner');
  chip.textContent      = d.spinner.name;
  chip.style.background = d.spinner.color + '44';
  chip.style.borderLeft = `4px solid ${d.spinner.color}`;

  tgAnimateSpin(
    document.getElementById('tg-host-wheel-spin'),
    d.wheelSegments, tgWheelRotation, d.resultIndex,
    () => { tgWheelRotation = tgWheelRotation; }
  );
}

function tgHandleAdjResult(d) {
  showPhasePanel('p-tg-adj-result');
  timerMax = 4;
  document.getElementById('hdr-phase').textContent = 'New Tag!';
  document.getElementById('tg-ar-adj').textContent = d.adjective;

  const chip = document.getElementById('tg-ar-spinner');
  chip.textContent       = `${d.spinner.name} gets:`;
  chip.style.background  = d.spinner.color + '44';
  chip.style.borderLeft  = `4px solid ${d.spinner.color}`;

  tgDrawWheel(document.getElementById('tg-host-wheel-adj'), tgWheelSegments, tgWheelRotation);
  tgRenderPlayerTags('tg-ar-players', d.allPlayers, d.spinner.id);
}

function tgHandleEventResult(d) {
  showPhasePanel('p-tg-event-result');
  timerMax = 5;
  document.getElementById('hdr-phase').textContent = 'Event!';

  const chip = document.getElementById('tg-er-spinner');
  chip.textContent       = d.spinner.name;
  chip.style.background  = d.spinner.color + '44';
  chip.style.borderLeft  = `4px solid ${d.spinner.color}`;

  const ev = d.event;
  document.getElementById('tg-er-event').innerHTML = `
    <div class="tg-event-icon">${esc(ev.icon)}</div>
    <div class="tg-event-name">${esc(ev.name)}</div>
    <div class="tg-event-desc">${esc(ev.description)}</div>
  `;
  tgDrawWheel(document.getElementById('tg-host-wheel-evt'), tgWheelSegments, tgWheelRotation);
}

function tgHandleEventResolve(d) {
  showPhasePanel('p-tg-event-resolve');
  document.getElementById('hdr-phase').textContent = 'Event Resolving…';

  const ev = d.event;
  document.getElementById('tg-evr-event').innerHTML = `
    <div class="tg-event-name">${esc(ev.icon)} ${esc(ev.name)}</div>
    <div class="tg-event-desc">${esc(ev.description)}</div>
  `;
  document.getElementById('tg-evr-status').textContent =
    ev.needsChoice === 'vote'
      ? `Waiting for audience votes…`
      : `Waiting for ${esc(d.spinner.name)} to choose…`;

  tgDrawWheel(document.getElementById('tg-host-wheel-evr'), tgWheelSegments, tgWheelRotation);
  tgRenderPlayerTags('tg-evr-players', d.allPlayers);
}

function tgHandleEventApplied(d) {
  showPhasePanel('p-tg-event-applied');
  document.getElementById('hdr-phase').textContent = 'Tags Updated';
  tgDrawWheel(document.getElementById('tg-host-wheel-eva'), tgWheelSegments, tgWheelRotation);
  tgRenderPlayerTags('tg-eva-players', d.allPlayers);
}

function tgHandleTaskIntro(d) {
  showPhasePanel('p-tg-task-intro');
  timerMax = 6;
  document.getElementById('hdr-phase').textContent = 'Task!';
  document.getElementById('tg-ti-prompt').textContent = d.task.prompt;

  const perfEl = document.getElementById('tg-ti-performers');
  perfEl.innerHTML = d.performers.map(p => `
    <div class="tg-spinner-badge" style="background:${p.color}44;border-left:4px solid ${p.color};">
      ${esc(p.name)} ${p.immune ? '🛡️' : ''}
    </div>
  `).join('');

  tgRenderPlayerTags('tg-ti-players', d.allPlayers);
}

function tgHandleSkit(d) {
  showPhasePanel('p-tg-skit');
  timerMax = d.timeLeft;
  document.getElementById('hdr-phase').textContent = 'Skit!';
  document.getElementById('tg-skit-prompt').textContent = d.task.prompt;
  document.getElementById('tg-skit-threshold').textContent =
    `${d.threshold} / ${d.nonPerformerCount} votes to fail`;

  tgRenderSkitPerformers(d.performers, d.calloutData, d.threshold, d.nonPerformerCount);
}

function tgHandlePerfVote(d) {
  showPhasePanel('p-tg-perf-vote');
  timerMax = d.timeLeft;
  document.getElementById('hdr-phase').textContent = 'Rate the performance!';
  document.getElementById('tg-pv-avg').textContent  = '?';
  document.getElementById('tg-pv-count').textContent = `0 / ${d.voterCount} voted`;
  document.getElementById('tg-pv-bar').style.width = '0%';

  const perfEl = document.getElementById('tg-pv-performers');
  perfEl.innerHTML = d.performers.map(p => `
    <div class="tg-spinner-badge" style="background:${p.color}44;border-left:4px solid ${p.color};">
      ${esc(p.name)} ${p.immune ? '🛡️' : ''}
    </div>
  `).join('');
}

socket.on('host:vote_update', ({ votesIn, voterCount, avgRating }) => {
  document.getElementById('tg-pv-avg').textContent   = avgRating.toFixed(1);
  document.getElementById('tg-pv-count').textContent = `${votesIn} / ${voterCount} voted`;
  document.getElementById('tg-pv-bar').style.width   = (votesIn / Math.max(voterCount, 1) * 100) + '%';
});

function tgHandleSkitResult(d) {
  showPhasePanel('p-tg-skit-result');
  timerMax = 8;
  document.getElementById('hdr-phase').textContent = 'Results';

  // Rating banner
  const ratingStars = '⭐'.repeat(Math.round(d.avgRating || 0));
  document.getElementById('hdr-phase').textContent = `Results · ${d.avgRating}/10 ${ratingStars}`;

  const resEl = document.getElementById('tg-sr-results');
  resEl.innerHTML = d.performerResults.map(p => `
    <div class="performer-card ${p.immune ? 'immune-glow' : ''}" style="border-top:3px solid ${p.color};">
      <div class="performer-card-name">${esc(p.name)}</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:4px;">
        Rating: +${p.ratingPts}
        ${p.immuneBonus ? ` · Immunity: +${p.immuneBonus}` : ''}
        ${p.penalty ? ` · Failed tags: −${p.penalty}` : ''}
        → <strong style="color:var(--teal);">+${p.delta}</strong>
      </div>
      ${p.survivedTags.map(t => `<div class="performer-tag-row"><span>${esc(t)}</span><span style="color:var(--teal);">✓</span></div>`).join('')}
      ${p.failedTags.map(t  => `<div class="performer-tag-row failed"><span>${esc(t)}</span><span style="color:var(--coral);">✗ −100</span></div>`).join('')}
    </div>
  `).join('');

  const scEl = document.getElementById('tg-sr-scores');
  scEl.innerHTML = d.allPlayers.map(p => `
    <div class="score-row">
      <div class="player-dot" style="background:${p.color}"></div>
      <div class="score-name">${esc(p.name)}</div>
      <div class="score-total">${p.score}</div>
    </div>
  `).join('');
}

socket.on('host:callout_update', ({ calloutData }) => {
  if (currentPhase === 'skit') {
    // Re-render performer cards with updated callout pips
    // We don't have performers/threshold cached here, use last known
    const performers = window._tgLastPerformers || [];
    const threshold  = window._tgLastThreshold  || 1;
    const total      = window._tgLastNonPerf     || 1;
    tgRenderSkitPerformers(performers, calloutData, threshold, total);
  }
});

socket.on('host:tag_failed', ({ performerName, tag }) => {
  // Flash a notification
  const notif = document.createElement('div');
  notif.style.cssText = `
    position:fixed;top:80px;right:24px;
    background:var(--coral);color:#fff;
    border-radius:12px;padding:12px 20px;
    font-weight:800;font-size:18px;
    z-index:999;animation:fadeOut 3s forwards;
  `;
  notif.textContent = `❌ ${performerName}: "${tag}" FAILED!`;
  document.body.appendChild(notif);
  setTimeout(() => notif.remove(), 3000);
});

// TagGame game_over is handled inline in tgHandleSkitResult flow
// This stub is called from the main host:phase handler
function tgHandleGameOver(data) {
  showPhasePanel('p-tg-tg-gameover');
  document.getElementById('hdr-phase').textContent = 'Game Over';
  const medals = ['🥇','🥈','🥉'];
  const heights = [200,160,120];
  const podOrder = data.players.length >= 3 ? [1,0,2] : [0,1,2];
  const podium = document.getElementById('tg-podium');
  podium.innerHTML = podOrder.filter(i => data.players[i]).map(i => {
    const p = data.players[i];
    return `<div class="podium-slot">
      <div class="podium-name">${esc(p.name)}</div>
      <div class="podium-score">${p.score} pts</div>
      <div class="podium-block" style="height:${heights[i]}px;background:${p.color};color:#000;">${medals[i]||p.rank}</div>
    </div>`;
  }).join('');

  const fl = document.getElementById('tg-final-list');
  fl.innerHTML = data.players.map(p => `
    <div class="final-row">
      <div class="final-rank">${p.rank}</div>
      <div class="player-dot" style="background:${p.color}"></div>
      <div class="final-name">${esc(p.name)}</div>
      <div class="final-score">${p.score} pts</div>
    </div>
  `).join('');
}

// ── TagGame UI helpers ─────────────────────────────────────

function tgRenderPlayerTags(elId, players, highlightId = null) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = players.map(p => `
    <div class="tg-player-row" style="${p.id === highlightId ? 'border:1px solid '+p.color : ''}">
      <div class="tg-player-dot" style="background:${p.color}"></div>
      <div class="tg-player-name">${esc(p.name)}</div>
      ${p.immune ? '<div class="tg-immune-badge">🛡️ Immune</div>' : ''}
      ${p.tags.map(t => `<span class="tg-tag-chip">${esc(t)}</span>`).join('')}
      ${p.tags.length === 0 ? '<span style="color:var(--muted);font-size:12px;">No tags yet</span>' : ''}
    </div>
  `).join('');
}

function tgRenderSkitPerformers(performers, calloutData, threshold, nonPerformerCount) {
  currentPhase = 'skit';
  window._tgLastPerformers = performers;
  window._tgLastThreshold  = threshold;
  window._tgLastNonPerf    = nonPerformerCount;

  const el = document.getElementById('tg-skit-performers');
  if (!el) return;

  el.innerHTML = performers.map(p => {
    const tagRows = p.tags.map(tag => {
      const key    = `${p.id}:${tag}`;
      const entry  = calloutData?.[key];
      const count  = entry?.count || 0;
      const failed = entry?.failed || false;
      const pips   = Array.from({ length: Math.max(threshold, count) }, (_, i) =>
        `<div class="callout-pip ${i < count ? (failed ? 'fail' : 'filled') : ''}"></div>`
      ).join('');
      return `
        <div class="performer-tag-row ${failed ? 'failed' : ''}">
          <span>${esc(tag)}</span>
          <div class="callout-bar">${pips}<span style="font-size:12px;color:var(--muted);margin-left:4px;">${count}/${threshold}</span></div>
        </div>
      `;
    }).join('');

    return `
      <div class="performer-card ${p.immune ? 'immune-glow' : ''}" style="border-top:3px solid ${p.color}">
        <div class="performer-card-name">${esc(p.name)} ${p.immune ? '🛡️' : ''}</div>
        ${tagRows || '<p style="color:var(--muted);font-size:13px;">No tags</p>'}
      </div>
    `;
  }).join('');
}

// ═══════════════════════════════════════════════════════════
// GSLS — General Statement's Last Stand host handlers
// ═══════════════════════════════════════════════════════════

let gslsAideCtx = null;  // current active aide canvas context

function gslsShowPanel(id) {
  document.querySelectorAll('.gsls-panel').forEach(p => p.style.display = 'none');
  const el = document.getElementById(id);
  if (el) el.style.display = 'flex';
}

function gslsSetTimer(timeLeft, max) {
  document.getElementById('gsls-timer-num').textContent = timeLeft;
  const pct = max > 0 ? timeLeft / max : 0;
  const circ = document.getElementById('gsls-timer-circle');
  if (circ) circ.style.strokeDashoffset = 100 * (1 - pct);
}

function gslsForbiddenHtml(words) {
  return (words || []).map(w =>
    `<span class="gsls-forbidden-pill">${esc(w)}</span>`
  ).join('');
}

function gslsHecklesToHtml(heckles) {
  return (heckles || []).map(h =>
    `<div class="gsls-heckle-item">"${esc(h)}"</div>`
  ).join('');
}

function gslsScoreboard(players) {
  const el = document.getElementById('gsls-scoreboard');
  if (!el || !players) return;
  el.innerHTML = [...players].sort((a,b) => b.score - a.score).map(p =>
    `<div class="gsls-score-row">
      <div style="width:10px;height:10px;border-radius:50%;background:${p.color};flex-shrink:0;"></div>
      <div style="flex:1;font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(p.name)}</div>
      <div style="font-size:13px;font-weight:900;color:var(--teal);">${p.score}</div>
    </div>`
  ).join('');
}

function gslsRoleBadge(elId, name, color) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = name;
  el.style.borderLeft = `4px solid ${color}`;
  el.style.background = color + '22';
}

function gslsInitAideCanvas(canvasId) {
  const c = document.getElementById(canvasId);
  if (!c) return null;
  c.width  = c.offsetWidth  || 400;
  c.height = c.offsetHeight || 220;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, c.width, c.height);
  return ctx;
}

function gslsDrawOnCanvas(ctx, ev) {
  if (!ctx) return;
  const w = ctx.canvas.width, h = ctx.canvas.height;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (ev.type === 'line') {
    ctx.beginPath();
    ctx.moveTo(ev.x0 * w, ev.y0 * h);
    ctx.lineTo(ev.x1 * w, ev.y1 * h);
    ctx.strokeStyle = ev.color; ctx.lineWidth = ev.size; ctx.stroke();
  } else if (ev.type === 'dot') {
    ctx.beginPath();
    ctx.arc(ev.x * w, ev.y * h, ev.size / 2, 0, Math.PI * 2);
    ctx.fillStyle = ev.color; ctx.fill();
  } else if (ev.type === 'clear') {
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, w, h);
  }
}

// ── GSLS socket events ──────────────────────────────────────

socket.on('host:phase', (data) => {
  if (data.game !== 'gsls') return;

  showScreen('s-gsls');
  document.getElementById('gsls-hdr-turn').textContent =
    data.turnNumber != null ? `Turn ${data.turnNumber}/${data.totalTurns}` : '⚔️ Last Stand';

  switch (data.phase) {

    case 'turn_setup':
      gslsShowPanel('gp-setup');
      document.getElementById('gsls-hdr-phase').textContent = 'Turn Setup';
      gslsSetTimer(4, 4);
      document.getElementById('gp-setup-speaker-name').textContent = data.speaker.name;
      document.getElementById('gp-setup-speaker-name').style.color = data.speaker.color;
      document.getElementById('gp-setup-aide-name').textContent = data.aide.name;
      document.getElementById('gp-setup-aide-name').style.color = data.aide.color;
      document.getElementById('gp-setup-topic').textContent = data.truePromptText;
      break;

    case 'prep':
      gslsShowPanel('gp-prep');
      document.getElementById('gsls-hdr-phase').textContent = 'Prep';
      gslsSetTimer(data.timeLeft || 30, 30);
      gslsRoleBadge('gp-prep-speaker-badge', '🎙️ ' + data.speakerName, '#4ecdc4');
      gslsRoleBadge('gp-prep-aide-badge', '✏️ ' + data.aideName, '#ffeaa7');
      document.getElementById('gp-prep-topic').textContent = data.truePromptText || '';
      gslsAideCtx = gslsInitAideCanvas('gsls-aide-canvas');
      break;

    case 'part1':
      gslsShowPanel('gp-part1');
      document.getElementById('gsls-hdr-phase').textContent = 'Part 1 — Opening';
      gslsSetTimer(data.timeLeft || 45, 45);
      gslsRoleBadge('gp-part1-speaker-badge', '🎙️ ' + data.speakerName, data.speakerColor);
      gslsRoleBadge('gp-part1-aide-badge', '✏️ ' + data.aideName, data.aideColor);
      document.getElementById('gp-part1-topic').textContent = data.truePromptText || '';
      document.getElementById('gp-part1-forbidden').innerHTML = gslsForbiddenHtml(data.forbidden);
      document.getElementById('gp-part1-napkin-count').textContent = 'Napkins sent: 0';
      gslsAideCtx = gslsInitAideCanvas('gsls-aide-canvas-p1');
      document.getElementById('gsls-reaction-meter').textContent = '—';
      break;

    case 'part2':
      gslsShowPanel('gp-part2');
      document.getElementById('gsls-hdr-phase').textContent = 'Part 2 — Address';
      gslsSetTimer(data.timeLeft || 60, 60);
      gslsRoleBadge('gp-part2-speaker-badge', '🎙️ ' + data.speakerName, data.speakerColor);
      gslsRoleBadge('gp-part2-aide-badge', '✏️ ' + data.aideName, data.aideColor);
      document.getElementById('gp-part2-topic').textContent = data.truePromptText || '';
      document.getElementById('gp-part2-napkin-count').textContent = 'Napkins sent: 0';
      gslsAideCtx = gslsInitAideCanvas('gsls-aide-canvas-p2');
      document.getElementById('gsls-reaction-meter-p2').textContent = '—';
      break;

    case 'part3':
      gslsShowPanel('gp-part3');
      document.getElementById('gsls-hdr-phase').textContent = 'Part 3 — Heckles';
      gslsSetTimer(data.timeLeft || 20, 20);
      document.getElementById('gp-part3-count').textContent = `0/${data.audienceSize || 0}`;
      break;

    case 'part3_respond':
      gslsShowPanel('gp-part3r');
      document.getElementById('gsls-hdr-phase').textContent = 'Part 3 — Challenge';
      gslsSetTimer(data.timeLeft || 45, 45);
      gslsRoleBadge('gp-part3r-speaker-badge', '🎙️ ' + data.speakerName, data.speakerColor);
      document.getElementById('gp-part3r-heckles').innerHTML = gslsHecklesToHtml(data.heckles);
      document.getElementById('gsls-reaction-meter-p3').textContent = '—';
      break;

    case 'voting':
      gslsShowPanel('gp-voting');
      document.getElementById('gsls-hdr-phase').textContent = 'Voting';
      gslsSetTimer(data.timeLeft || 20, 20);
      document.getElementById('gp-voting-count').textContent = `0/${data.total || 0}`;
      break;

    case 'reveal': {
      gslsShowPanel('gp-reveal');
      document.getElementById('gsls-hdr-phase').textContent = 'Reveal!';
      gslsSetTimer(10, 10);
      document.getElementById('gp-reveal-true').textContent  = data.truePromptText;
      document.getElementById('gp-reveal-decoy').textContent = data.decoyPromptText;
      const had = data.speakerHadTrue ? 'TRUE prompt 🎯' : 'DECOY prompt 🎭';
      const color = data.speakerHadTrue ? 'var(--teal)' : 'var(--coral)';
      const resEl = document.getElementById('gp-reveal-result');
      resEl.innerHTML = `<span style="color:var(--muted);">${esc(data.speakerName)}</span> had the <span style="color:${color};font-size:28px;">${had}</span>`;
      resEl.style.background = data.speakerHadTrue ? '#1a3a2a' : '#3a1a1a';
      if (data.deceptionBonus) resEl.innerHTML += ` <span style="color:var(--teal);font-size:20px;">+${data.deceptionBonus} Deception Bonus!</span>`;
      const sc = document.getElementById('gp-reveal-scores');
      sc.innerHTML = `
        <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:14px;">
          <div style="background:var(--surface);padding:10px 16px;border-radius:8px;"><span style="color:var(--muted);">Speaker</span> <strong style="color:var(--teal);">+${data.speakerScore}</strong></div>
          <div style="background:var(--surface);padding:10px 16px;border-radius:8px;"><span style="color:var(--muted);">Aide</span> <strong style="color:#ffeaa7;">+${data.aideScore}</strong></div>
          <div style="background:var(--surface);padding:10px 16px;border-radius:8px;"><span style="color:var(--muted);">True votes</span> <strong>${data.trueVotes}</strong> / Decoy <strong>${data.decoyVotes}</strong></div>
        </div>`;
      gslsScoreboard(data.players);
      break;
    }

    case 'last_stand_intro': {
      gslsShowPanel('gp-ls-intro');
      document.getElementById('gsls-hdr-phase').textContent = '⚔️ LAST STAND';
      document.getElementById('gsls-hdr-turn').textContent = '⚔️ Last Stand';
      gslsSetTimer(5, 5);
      const d1c = document.getElementById('gp-ls-d1-card');
      d1c.innerHTML = `<div style="color:var(--muted);font-size:11px;font-weight:700;text-transform:uppercase;">Debater 1</div><div style="font-size:24px;font-weight:900;color:${data.debater1.color}">${esc(data.debater1.name)}</div>`;
      const d2c = document.getElementById('gp-ls-d2-card');
      d2c.innerHTML = `<div style="color:var(--muted);font-size:11px;font-weight:700;text-transform:uppercase;">Debater 2</div><div style="font-size:24px;font-weight:900;color:${data.debater2.color}">${esc(data.debater2.name)}</div>`;
      document.getElementById('gp-ls-intro-topic1').textContent = data.trueTopics[0];
      document.getElementById('gp-ls-intro-topic2').textContent = data.trueTopics[1];
      break;
    }

    case 'last_stand_prep':
      gslsShowPanel('gp-ls-prep');
      document.getElementById('gsls-hdr-phase').textContent = 'Last Stand Prep';
      gslsSetTimer(data.timeLeft || 30, 30);
      // forbidden words shown after first phase
      break;

    case 'last_stand_debate':
      gslsShowPanel('gp-ls-debate');
      document.getElementById('gsls-hdr-phase').textContent = '⚔️ Debate';
      gslsSetTimer(data.timeLeft || 150, 150);
      gslsRoleBadge('gp-ls-d1-badge', data.debater1.name, data.debater1.color);
      gslsRoleBadge('gp-ls-d2-badge', data.debater2.name, data.debater2.color);
      document.getElementById('gp-ls-debate-forbidden').innerHTML = gslsForbiddenHtml(data.forbidden);
      break;

    case 'last_stand_heckle':
      gslsShowPanel('gp-ls-heckle');
      document.getElementById('gsls-hdr-phase').textContent = 'Audience Questions';
      gslsSetTimer(data.timeLeft || 20, 20);
      document.getElementById('gp-ls-heckle-count').textContent = `0/${data.total || 0}`;
      break;

    case 'last_stand_challenge':
      gslsShowPanel('gp-ls-challenge');
      document.getElementById('gsls-hdr-phase').textContent = '⚔️ Challenge';
      gslsSetTimer(data.timeLeft || 45, 45);
      document.getElementById('gp-ls-challenge-heckles').innerHTML = gslsHecklesToHtml(data.heckles);
      document.getElementById('gp-ls-challenge-forbidden').innerHTML = gslsForbiddenHtml(data.forbidden);
      break;

    case 'last_stand_voting':
      gslsShowPanel('gp-ls-voting');
      document.getElementById('gsls-hdr-phase').textContent = 'Vote — Who Won?';
      gslsSetTimer(data.timeLeft || 20, 20);
      document.getElementById('gp-ls-vote-count').textContent = `0/${data.total || 0}`;
      break;

    case 'last_stand_reveal': {
      gslsShowPanel('gp-ls-reveal');
      document.getElementById('gsls-hdr-phase').textContent = '🎭 Reveal!';
      gslsSetTimer(10, 10);
      const winner = data.winnerId === data.debater1.id ? data.debater1 : data.debater2;
      document.getElementById('gp-ls-reveal-winner').innerHTML =
        `🏆 <span style="color:${winner.color};">${esc(winner.name)}</span> wins the debate!`;
      document.getElementById('gp-ls-reveal-winner').style.background = winner.color + '22';
      const d1r = document.getElementById('gp-ls-reveal-d1');
      d1r.innerHTML = `<div style="font-size:11px;color:var(--muted);font-weight:700;margin-bottom:4px;">${esc(data.debater1.name)} was arguing about…</div><div style="background:#1a2a3a;border-left:4px solid ${data.debater1.color};padding:12px;border-radius:8px;">${esc(data.debater1.prompt)}</div><div style="margin-top:4px;font-size:13px;color:var(--muted);">${data.debater1.votes} vote${data.debater1.votes !== 1 ? 's' : ''}</div>`;
      const d2r = document.getElementById('gp-ls-reveal-d2');
      d2r.innerHTML = `<div style="font-size:11px;color:var(--muted);font-weight:700;margin-bottom:4px;">${esc(data.debater2.name)} was arguing about…</div><div style="background:#1a2a3a;border-left:4px solid ${data.debater2.color};padding:12px;border-radius:8px;">${esc(data.debater2.prompt)}</div><div style="margin-top:4px;font-size:13px;color:var(--muted);">${data.debater2.votes} vote${data.debater2.votes !== 1 ? 's' : ''}</div>`;
      gslsScoreboard(data.players);
      break;
    }
  }
});

// GSLS game_over
socket.on('host:phase', (data) => {
  if (data.game !== 'gsls' || data.phase !== 'game_over') return;
  showScreen('s-gsls');
  gslsShowPanel('gp-gameover');
  document.getElementById('gsls-hdr-phase').textContent = 'Game Over';
  const medals = ['🥇','🥈','🥉'];
  const heights = [200,160,120];
  const top3 = data.players.slice(0,3);
  const order = top3.length >= 3 ? [1,0,2] : [0,1,2];
  document.getElementById('gp-go-podium').innerHTML = order.filter(i => top3[i]).map(i => {
    const p = top3[i];
    return `<div class="podium-slot"><div class="podium-name">${esc(p.name)}</div><div class="podium-score">${p.score} pts</div><div class="podium-block" style="height:${heights[i]}px;background:${p.color};color:#000;">${medals[i]||p.rank}</div></div>`;
  }).join('');
  document.getElementById('gp-go-list').innerHTML = data.players.map(p =>
    `<div class="final-row"><div class="final-rank">${p.rank}</div><div class="player-dot" style="background:${p.color}"></div><div class="final-name">${esc(p.name)}</div><div class="final-score">${p.score} pts</div></div>`
  ).join('');
});

socket.on('timer', ({ timeLeft }) => {
  if (!document.getElementById('s-gsls').classList.contains('active')) return;
  const num = document.getElementById('gsls-timer-num');
  if (num) {
    const max = parseInt(num.dataset.max || timeLeft) || timeLeft;
    gslsSetTimer(timeLeft, max);
  }
});

socket.on('gsls:aide_draw', ({ event }) => {
  gslsDrawOnCanvas(gslsAideCtx, event);
});

socket.on('gsls:napkin_sent', ({ count }) => {
  ['gp-part1-napkin-count','gp-part2-napkin-count'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = `Napkins sent: ${count}`;
  });
});

socket.on('gsls:heckle_count', ({ submitted, total }) => {
  const ids = ['gp-part3-count','gp-ls-heckle-count'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = `${submitted}/${total}`;
  });
});

socket.on('gsls:vote_count', ({ voted, total }) => {
  const ids = ['gp-voting-count','gp-ls-vote-count'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = `${voted}/${total}`;
  });
});

socket.on('gsls:reaction_update', ({ reactions }) => {
  const total = Object.values(reactions).reduce((s, r) => s + r.net, 0);
  const sign = total >= 0 ? '+' : '';
  const str = `${sign}${total} net`;
  ['gsls-reaction-meter','gsls-reaction-meter-p2','gsls-reaction-meter-p3'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = str; el.style.color = total >= 0 ? 'var(--teal)' : 'var(--coral)'; }
  });
});

// ═══════════════════════════════════════════════════════════
// OVERRULED! host handlers
// ═══════════════════════════════════════════════════════════

let orDrawCtx = null;

function orShowPanel(id) {
  document.querySelectorAll('.or-panel').forEach(p => p.style.display = 'none');
  const el = document.getElementById(id);
  if (el) el.style.display = 'flex';
}

function orSetTimer(t, max) {
  document.getElementById('or-timer-num').textContent = t;
  const c = document.getElementById('or-timer-circle');
  if (c) c.style.strokeDashoffset = 94 * (1 - (max > 0 ? t / max : 0));
}

function orRoleBadge(elId, name, color) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = name;
  el.style.borderLeft = `3px solid ${color}`;
  el.style.background = color + '22';
}

function orEvidenceHtml(ev) {
  if (!ev) return '';
  const styles = {
    text_message: { bg: '#0d1b2a', border: '#4ecdc4', icon: '📱', title: 'Text Message' },
    witness:      { bg: '#1a1a2a', border: '#96ceb4', icon: '👁️', title: 'Witness Testimony' },
    document:     { bg: '#1a1a0d', border: '#e9c46a', icon: '📄', title: 'Official Document' },
    cctv:         { bg: '#0d0d0d', border: '#aaaaaa', icon: '📹', title: 'CCTV Footage' },
  };
  const s = styles[ev.type] || { bg: '#1a1a2a', border: '#e9c46a', icon: '📋', title: ev.label || 'Evidence' };
  if (ev.type === 'drawing') {
    return `<div class="or-evidence-box" style="background:#fff;border:3px solid #e9c46a;padding:0;overflow:hidden;">
      <div style="background:#e9c46a;color:#000;font-weight:800;padding:6px 12px;font-size:13px;">🎨 Exhibit A</div>
      ${ev.imageData ? `<img src="${ev.imageData}" style="width:100%;display:block;max-height:280px;object-fit:contain;" />` : '<div style="height:200px;display:flex;align-items:center;justify-content:center;color:#999;font-size:14px;">[Drawing in progress]</div>'}
    </div>`;
  }
  return `<div class="or-evidence-box" style="background:${s.bg};border-left:4px solid ${s.border};">
    <div style="font-size:11px;font-weight:700;color:${s.border};margin-bottom:6px;">${s.icon} ${s.title.toUpperCase()}</div>
    <div style="white-space:pre-wrap;font-size:15px;">${esc(ev.text || '')}</div>
  </div>`;
}

function orScoreboard(players) {
  const el = document.getElementById('or-scoreboard');
  if (!el || !players) return;
  el.innerHTML = [...players].sort((a, b) => b.score - a.score).map(p =>
    `<div style="display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid #2a2a3a;">
      <div style="width:8px;height:8px;border-radius:50%;background:${p.color};flex-shrink:0;"></div>
      <div style="flex:1;font-size:12px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(p.name)}</div>
      <div style="font-size:12px;font-weight:900;color:#e9c46a;">${p.score}</div>
    </div>`
  ).join('');
}

function orRolesSidebar(judgeN, prosN, defN, juryN) {
  document.getElementById('or-roles-sidebar').innerHTML =
    `<div style="color:var(--muted)">⚖️ <strong>${esc(judgeN)}</strong></div>
     <div style="color:var(--coral)">⚔️ <strong>${esc(prosN)}</strong></div>
     <div style="color:var(--teal)">🛡️ <strong>${esc(defN)}</strong></div>
     <div style="color:var(--muted)">${esc(juryN)}</div>`;
}

socket.on('host:phase', (data) => {
  if (data.game !== 'overruled') return;
  showScreen('s-overruled');
  document.getElementById('or-hdr-trial').textContent =
    `Trial ${data.trialNumber || '?'}/${data.totalTrials || '?'}`;

  switch (data.phase) {

    case 'trial_setup':
      orShowPanel('or-p-setup');
      document.getElementById('or-hdr-phase').textContent = '⚖️ Court is in Session';
      orSetTimer(4, 4);
      document.getElementById('or-setup-judge-name').textContent  = data.judge?.name  ?? '—';
      document.getElementById('or-setup-judge-name').style.color  = data.judge?.color ?? '';
      document.getElementById('or-setup-pros-name').textContent   = data.prosecutor?.name  ?? '—';
      document.getElementById('or-setup-pros-name').style.color   = data.prosecutor?.color ?? '';
      document.getElementById('or-setup-def-name').textContent    = data.defendant?.name   ?? '—';
      document.getElementById('or-setup-def-name').style.color    = data.defendant?.color  ?? '';
      document.getElementById('or-setup-jury-names').textContent  = (data.jury || []).map(p => p.name).join(', ') || '—';
      orRolesSidebar(data.judge?.name, data.prosecutor?.name, data.defendant?.name,
        (data.jury||[]).map(p=>p.name).join(', ') || 'none');
      break;

    case 'crime_reveal':
      orShowPanel('or-p-crime');
      document.getElementById('or-hdr-phase').textContent = '📋 The Charge';
      orSetTimer(data.timeLeft || 20, 20);
      document.getElementById('or-crime-judge-label').textContent = `${data.judgeName} is selecting the charge…`;
      document.getElementById('or-crime-display').style.display = 'none';
      document.getElementById('or-crime-waiting').style.display = 'block';
      break;

    case 'evidence_create': {
      orShowPanel('or-p-ev-create');
      document.getElementById('or-hdr-phase').textContent = `Evidence ${data.evidenceRound}/3 — Creating`;
      orSetTimer(data.timeLeft || 60, data.evidenceType?.input === 'draw' ? 90 : 60);
      document.getElementById('or-ev-round-create').textContent = data.evidenceRound;
      document.getElementById('or-ev-type-label').textContent   = data.evidenceType?.label ?? '';
      document.getElementById('or-ev-create-crime').textContent = data.crime?.text ?? '';
      orRoleBadge('or-ev-create-pros-badge', data.prosecutorName, '#ff6b6b');
      const canvas = document.getElementById('or-draw-canvas');
      if (data.evidenceType?.input === 'draw') {
        canvas.style.display = 'block';
        canvas.width  = canvas.offsetWidth  || 420;
        canvas.height = 280;
        const ctx2 = canvas.getContext('2d');
        ctx2.fillStyle = 'white'; ctx2.fillRect(0, 0, canvas.width, canvas.height);
        orDrawCtx = ctx2;
      } else {
        canvas.style.display = 'none';
        orDrawCtx = null;
      }
      break;
    }

    case 'evidence_present':
      orShowPanel('or-p-ev-present');
      document.getElementById('or-hdr-phase').textContent = `Evidence ${data.evidenceRound}/3 — Prosecution`;
      orSetTimer(data.timeLeft || 40, 40);
      document.getElementById('or-ev-round-present').textContent = data.evidenceRound;
      document.getElementById('or-evidence-display').innerHTML   = orEvidenceHtml(data.evidence);
      document.getElementById('or-objection-banner').style.display = 'none';
      document.getElementById('or-reaction-present').textContent = '—';
      break;

    case 'objection_rule_present':
    case 'objection_rule_respond':
      orShowPanel('or-p-obj-rule');
      document.getElementById('or-hdr-phase').textContent = '⚠️ OBJECTION!';
      orSetTimer(data.timeLeft || 25, 25);
      document.getElementById('or-obj-filer').textContent =
        `${data.filerName} objects! ${data.objection?.phase === 'present' ? '(to the evidence)' : '(to the response)'}`;
      document.getElementById('or-obj-sustain-list').innerHTML =
        (data.sustainGuidelines || []).map(g => `• ${esc(g)}`).join('<br>');
      document.getElementById('or-obj-overrule-list').innerHTML =
        (data.overruleGuidelines || []).map(g => `• ${esc(g)}`).join('<br>');
      document.getElementById('or-obj-judge-label').textContent = `${data.judgeName} is ruling…`;
      document.getElementById('or-obj-result').style.display = 'none';
      break;

    case 'evidence_respond':
      orShowPanel('or-p-ev-respond');
      document.getElementById('or-hdr-phase').textContent = `Evidence ${data.evidenceRound}/3 — Defence`;
      orSetTimer(data.timeLeft || 40, 40);
      document.getElementById('or-ev-round-respond').textContent  = data.evidenceRound;
      document.getElementById('or-respond-evidence').innerHTML     = orEvidenceHtml(data.evidence);
      document.getElementById('or-respond-objection-banner').style.display = 'none';
      document.getElementById('or-reaction-respond').textContent  = '—';
      break;

    case 'closing_prosecution':
      orShowPanel('or-p-closing-pros');
      document.getElementById('or-hdr-phase').textContent = '🔥 Closing — Prosecution';
      orSetTimer(data.timeLeft || 45, 45);
      orRoleBadge('or-closing-pros-badge', data.prosecutorName, '#ff6b6b');
      document.getElementById('or-closing-crime-pros').textContent = data.crime?.text ?? '';
      document.getElementById('or-reaction-closing-pros').textContent = '—';
      break;

    case 'closing_defence':
      orShowPanel('or-p-closing-def');
      document.getElementById('or-hdr-phase').textContent = '🛡️ Closing — Defence';
      orSetTimer(data.timeLeft || 45, 45);
      orRoleBadge('or-closing-def-badge', data.defendantName, '#4ecdc4');
      document.getElementById('or-closing-crime-def').textContent = data.crime?.text ?? '';
      document.getElementById('or-reaction-closing-def').textContent = '—';
      break;

    case 'verdict_vote':
      orShowPanel('or-p-verdict-vote');
      document.getElementById('or-hdr-phase').textContent = '🗳️ Jury Deliberates';
      orSetTimer(data.timeLeft || 25, 25);
      document.getElementById('or-verdict-crime').textContent = data.crime?.text ?? '';
      document.getElementById('or-vote-count').textContent = `0/${data.total || 0}`;
      break;

    case 'verdict_reveal': {
      orShowPanel('or-p-verdict-reveal');
      document.getElementById('or-hdr-phase').textContent = '⚖️ Verdict!';
      orSetTimer(10, 10);
      const banner = document.getElementById('or-verdict-banner');
      if (data.isGuilty) {
        banner.textContent = `⚖️ GUILTY`;
        banner.style.background = '#3a1a1a';
        banner.style.color = 'var(--coral)';
      } else {
        banner.textContent = `🎉 NOT GUILTY`;
        banner.style.background = '#1a3a2a';
        banner.style.color = 'var(--teal)';
      }
      document.getElementById('or-guilty-count').textContent    = data.guiltyVotes;
      document.getElementById('or-notguilty-count').textContent = data.notGuiltyVotes;
      const scEl = document.getElementById('or-verdict-scores');
      scEl.innerHTML = `
        <div style="display:flex;gap:10px;flex-wrap:wrap;font-size:13px;">
          <div style="background:var(--surface);padding:8px 14px;border-radius:8px;">
            ⚔️ <strong>${esc(data.prosecutorName)}</strong>
            ${data.isGuilty ? ' <span style="color:var(--teal);">+200</span>' : ''}
          </div>
          <div style="background:var(--surface);padding:8px 14px;border-radius:8px;">
            🛡️ <strong>${esc(data.defendantName)}</strong>
            ${!data.isGuilty ? ' <span style="color:var(--teal);">+200</span>' : ''}
          </div>
        </div>`;
      orScoreboard(data.players);
      break;
    }

    case 'game_over': {
      orShowPanel('or-p-gameover');
      document.getElementById('or-hdr-phase').textContent = 'Court Adjourned';
      const medals = ['🥇','🥈','🥉'], heights = [200,160,120];
      const top3 = data.players.slice(0,3);
      const order = top3.length >= 3 ? [1,0,2] : [0,1,2];
      document.getElementById('or-podium').innerHTML = order.filter(i=>top3[i]).map(i=>{
        const p=top3[i];
        return `<div class="podium-slot"><div class="podium-name">${esc(p.name)}</div><div class="podium-score">${p.score} pts</div><div class="podium-block" style="height:${heights[i]}px;background:${p.color};color:#000;">${medals[i]}</div></div>`;
      }).join('');
      document.getElementById('or-final-list').innerHTML = data.players.map(p=>
        `<div class="final-row"><div class="final-rank">${p.rank}</div><div class="player-dot" style="background:${p.color}"></div><div class="final-name">${esc(p.name)}</div><div class="final-score">${p.score}</div></div>`
      ).join('');
      break;
    }
  }
});

// ── Overruled live events ───────────────────────────────────

socket.on('overruled:crime_confirmed', ({ crime }) => {
  document.getElementById('or-crime-waiting').style.display = 'none';
  const d = document.getElementById('or-crime-display');
  d.textContent = crime.text;
  d.style.display = 'block';
});

socket.on('overruled:draw', ({ event }) => {
  if (!orDrawCtx) return;
  const c = orDrawCtx.canvas;
  const w = c.width, h = c.height;
  orDrawCtx.lineCap = 'round'; orDrawCtx.lineJoin = 'round';
  if (event.type === 'line') {
    orDrawCtx.beginPath(); orDrawCtx.moveTo(event.x0*w, event.y0*h);
    orDrawCtx.lineTo(event.x1*w, event.y1*h);
    orDrawCtx.strokeStyle = event.color; orDrawCtx.lineWidth = event.size; orDrawCtx.stroke();
  } else if (event.type === 'dot') {
    orDrawCtx.beginPath(); orDrawCtx.arc(event.x*w, event.y*h, event.size/2, 0, Math.PI*2);
    orDrawCtx.fillStyle = event.color; orDrawCtx.fill();
  } else if (event.type === 'clear') {
    orDrawCtx.fillStyle = 'white'; orDrawCtx.fillRect(0,0,w,h);
  }
});

socket.on('overruled:objection_filed', ({ filerName, filerRole, phase }) => {
  const bannerId = phase === 'present' ? 'or-objection-banner' : 'or-respond-objection-banner';
  const el = document.getElementById(bannerId);
  if (el) { el.textContent = `⚠️ OBJECTION! — ${filerName}`; el.style.display = 'block'; }
});

socket.on('overruled:ruling', ({ ruling }) => {
  const el = document.getElementById('or-obj-result');
  el.style.display = 'block';
  el.textContent = ruling === 'sustained' ? '✅ SUSTAINED' : '❌ OVERRULED';
  el.style.background = ruling === 'sustained' ? '#1a3a2a' : '#3a1a1a';
  el.style.color = ruling === 'sustained' ? 'var(--teal)' : 'var(--coral)';
});

socket.on('overruled:reaction_update', ({ net }) => {
  const s = `${net >= 0 ? '+' : ''}${net}`;
  const c = net >= 0 ? 'var(--teal)' : 'var(--coral)';
  ['or-reaction-present','or-reaction-respond','or-reaction-closing-pros','or-reaction-closing-def'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = s; el.style.color = c; }
  });
});

socket.on('overruled:vote_count', ({ voted, total }) => {
  const el = document.getElementById('or-vote-count');
  if (el) el.textContent = `${voted}/${total}`;
});

socket.on('timer', ({ timeLeft }) => {
  if (!document.getElementById('s-overruled')?.classList.contains('active')) return;
  const n = document.getElementById('or-timer-num');
  if (n) {
    const max = parseInt(n.dataset.max || timeLeft) || timeLeft;
    orSetTimer(timeLeft, max);
  }
});
