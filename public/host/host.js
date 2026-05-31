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

socket.on('room:created', ({ code }) => {
  roomCode = code;
  document.getElementById('lobby-code').textContent = code;
  const joinUrl = `${location.origin}/play?code=${code}`;
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
