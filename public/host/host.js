'use strict';

const socket = io();

// ── State ──────────────────────────────────────────────────
let roomCode      = null;
let currentPhase  = null;
let timerMax      = 60;

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
  socket.emit('game:start');
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

function tgDrawWheel(canvas, segments, rotationDeg) {
  if (!canvas || !segments) return;
  const ctx = canvas.getContext('2d');
  const cx  = canvas.width  / 2;
  const cy  = canvas.height / 2;
  const r   = Math.min(cx, cy) - 6;
  const n   = segments.length;
  const arc = (2 * Math.PI) / n;
  const off = (rotationDeg * Math.PI / 180) - Math.PI / 2;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const adjPalette = ['#1e3a5f','#243d6e','#2a4575','#1a3560','#1d3d6a','#20406d','#22427a','#193358'];

  segments.forEach((seg, i) => {
    const a0 = off + i * arc;
    const a1 = a0 + arc;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a0, a1);
    ctx.closePath();
    ctx.fillStyle = seg.type === 'event' ? '#6b3dcc' : adjPalette[i % adjPalette.length];
    ctx.fill();
    ctx.strokeStyle = '#0f0f1a';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Label
    const mid  = a0 + arc / 2;
    const tr   = r * 0.68;
    ctx.save();
    ctx.translate(cx + Math.cos(mid) * tr, cy + Math.sin(mid) * tr);
    ctx.rotate(mid + Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'white';
    ctx.font = `bold 10px sans-serif`;
    const label = seg.type === 'event' ? (seg.icon + ' ' + seg.name) : seg.value;
    const maxC  = Math.max(10, Math.floor(r / 20));
    ctx.fillText(label.length > maxC ? label.slice(0, maxC - 1) + '…' : label, 0, 0);
    ctx.restore();
  });

  // Outer ring
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.strokeStyle = '#7c4dff';
  ctx.lineWidth = 4;
  ctx.stroke();

  // Centre hub
  ctx.beginPath();
  ctx.arc(cx, cy, 16, 0, 2 * Math.PI);
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
  document.getElementById('hdr-phase').textContent = `Turn ${d.turnNumber}/${d.totalTurns}`;
  document.getElementById('hdr-round').textContent = 'Tag Out';

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
