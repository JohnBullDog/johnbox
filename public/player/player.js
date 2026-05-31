'use strict';

const socket = io();

// ── State ──────────────────────────────────────────────────
let myPlayer    = null;
let timerMax    = 60;
let drawColor   = '#1a1a1a';
let drawSize    = 6;
let isDrawing   = false;
let lastX = 0, lastY = 0;

// ── Helpers ────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setTimerBar(pct) {
  document.getElementById('timer-fill').style.width = (pct * 100) + '%';
}

// ── URL param auto-fill ────────────────────────────────────
(function () {
  const code = new URLSearchParams(location.search).get('code');
  if (code) document.getElementById('input-code').value = code.toUpperCase();
})();

// ── Join ───────────────────────────────────────────────────

document.getElementById('btn-join').addEventListener('click', submitJoin);
document.getElementById('input-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitJoin();
});

function submitJoin() {
  const code = document.getElementById('input-code').value.trim();
  const name = document.getElementById('input-name').value.trim();
  document.getElementById('join-err').textContent = '';
  if (!code) return setErr('join-err', 'Enter a room code.');
  if (!name) return setErr('join-err', 'Enter your name.');
  socket.emit('room:join', { code, playerName: name });
}

function setErr(id, msg) {
  document.getElementById(id).textContent = msg;
}

socket.on('room:joined', ({ code, player }) => {
  myPlayer = player;
  document.getElementById('lobby-code-display').textContent = code;
  document.getElementById('lobby-name').textContent = player.name;
  document.getElementById('lobby-avatar').style.background = player.color;
  showScreen('s-lobby');
});

socket.on('lobby:update', ({ players }) => {
  document.getElementById('lobby-player-count').textContent =
    `${players.length} player${players.length !== 1 ? 's' : ''} in the room`;
});

// ── Timer ──────────────────────────────────────────────────

socket.on('timer', ({ timeLeft }) => {
  const pct = timerMax > 0 ? timeLeft / timerMax : 0;
  setTimerBar(pct);
});

// ── Phase routing ──────────────────────────────────────────

socket.on('player:phase', (data) => {
  switch (data.phase) {
    case 'round_intro':   handleRoundIntro(data);   break;
    case 'drawing':       handleDrawing(data);       break;
    case 'guessing':      handleGuessing(data);      break;
    case 'voting':        handleVoting(data);        break;
    case 'round_results': handleResults(data);       break;
    case 'game_over':     handleGameOver(data);      break;
  }
});

// ── Round intro ────────────────────────────────────────────

function handleRoundIntro(d) {
  timerMax = 5;
  setTimerBar(1);
  document.getElementById('ri-round-num').textContent   = d.round;
  document.getElementById('ri-max-rounds').textContent  = d.maxRounds;
  document.getElementById('ri-drawer-label').textContent =
    d.isDrawer ? '🎨 You are drawing!' : `🖌 ${d.drawerName} is drawing`;
  showScreen('s-round-intro');
}

// ── Drawing phase ──────────────────────────────────────────

function handleDrawing(d) {
  if (d.role === 'drawer') {
    timerMax = d.timeLeft;
    setTimerBar(1);
    document.getElementById('draw-prompt-word').textContent = d.prompt;
    showScreen('s-drawing');              // make visible first so getBoundingClientRect works
    requestAnimationFrame(initCanvas);    // init canvas after layout is computed
  } else {
    showWaiting('👀', `${esc(d.drawerName)} is drawing…`, 'Watch the big screen!');
  }
}

// ── Guessing phase ─────────────────────────────────────────

function handleGuessing(d) {
  if (d.role === 'drawer') {
    showWaiting('⏳', 'Players are guessing!', `The word was: ${d.prompt}`);
  } else if (d.role === 'waiting') {
    showWaiting('✅', 'Answer submitted!', 'Waiting for others…', d.guess);
  } else {
    // guesser
    timerMax = d.timeLeft;
    setTimerBar(1);
    document.getElementById('text-err').textContent = '';
    document.getElementById('text-input').value = '';
    showScreen('s-text');
  }
}

// ── Voting phase ───────────────────────────────────────────

function handleVoting(d) {
  if (d.role === 'waiting') {
    showWaiting('✅', 'Vote cast!', 'Waiting for others…', d.voted);
    return;
  }

  timerMax = d.timeLeft;
  setTimerBar(1);
  document.getElementById('select-sub').textContent =
    d.myGuess ? `Your guess: "${d.myGuess}"` : 'Pick the real answer';

  const grid = document.getElementById('options-grid');
  grid.innerHTML = d.answers.map((ans, i) => {
    const isMine = d.myGuess && ans === d.myGuess;
    return `<button class="option-btn ${isMine ? 'is-mine' : ''}"
      data-answer="${esc(ans)}"
      ${isMine ? 'disabled title="Your own answer"' : ''}
      onclick="castVote(this, '${esc(ans)}')">
      ${esc(ans)}
    </button>`;
  }).join('');

  showScreen('s-select');
}

function castVote(btn, answer) {
  if (btn.disabled) return;
  document.querySelectorAll('.option-btn').forEach(b => b.disabled = true);
  btn.classList.add('selected');
  socket.emit('game:action', { type: 'submit_vote', answer });
}

// ── Round results ──────────────────────────────────────────

function handleResults(d) {
  const delta = d.myDelta ?? 0;
  const myP   = d.players.find(p => p.id === myPlayer?.id);

  const deltaEl = document.getElementById('results-delta');
  deltaEl.textContent = delta > 0 ? `+${delta}` : delta === 0 ? '—' : `${delta}`;
  deltaEl.className = `delta-badge ${delta === 0 ? 'zero' : ''}`;

  document.getElementById('results-msg').textContent   = delta > 0 ? 'Nice one!' : 'Better luck next round';
  document.getElementById('results-score').textContent = myP ? `Total: ${myP.score} pts` : '';

  // Build breakdown
  const breakdown = document.getElementById('results-breakdown');
  const myVote = [...(d.answerDetails || [])].find(a =>
    a.voters?.includes(myP?.name)
  );
  const lines = [];
  if (d.realPrompt) lines.push(`<strong>Real answer:</strong> ${esc(d.realPrompt)}`);
  if (myVote) {
    lines.push(myVote.isReal
      ? '✅ You guessed correctly!'
      : `You voted for a fake answer by ${esc(myVote.submitterName ?? 'someone')}`
    );
  }
  breakdown.innerHTML = lines.join('<br>');

  showScreen('s-results');
}

// ── Game over ──────────────────────────────────────────────

function handleGameOver(d) {
  const medals = ['🥇', '🥈', '🥉'];
  const badge  = document.getElementById('go-rank-badge');
  badge.textContent = medals[d.myRank - 1] ?? `#${d.myRank}`;

  const list = document.getElementById('go-player-list');
  list.innerHTML = d.players.map(p => {
    const isMe = myPlayer && p.id === myPlayer.id;
    return `<div class="final-player-row ${isMe ? 'fp-me' : ''}">
      <div class="fp-rank">${p.rank}</div>
      <div class="player-dot" style="width:14px;height:14px;border-radius:50%;background:${p.color};flex-shrink:0;"></div>
      <div class="fp-name">${esc(p.name)}${isMe ? ' (you)' : ''}</div>
      <div class="fp-score">${p.score} pts</div>
    </div>`;
  }).join('');

  showScreen('s-gameover');
}

// ── Waiting helper ─────────────────────────────────────────

function showWaiting(icon, title, sub, answer = null) {
  document.getElementById('waiting-icon').textContent  = icon;
  document.getElementById('waiting-title').textContent = title;
  document.getElementById('waiting-sub').textContent   = sub;
  const ansEl = document.getElementById('waiting-answer');
  if (answer) {
    ansEl.textContent = `"${answer}"`;
    ansEl.style.display = 'block';
  } else {
    ansEl.style.display = 'none';
  }
  showScreen('s-waiting');
}

// ── Text submit ────────────────────────────────────────────

document.getElementById('btn-submit-text').addEventListener('click', () => {
  const text = document.getElementById('text-input').value.trim();
  if (!text) return setErr('text-err', 'Type something first!');
  socket.emit('game:action', { type: 'submit_guess', text });
  showWaiting('✅', 'Answer submitted!', 'Waiting for others…', text);
});

// ── Drawing canvas ─────────────────────────────────────────

function initCanvas() {
  const canvas = document.getElementById('draw-canvas');
  const wrapper = canvas.parentElement;

  // Remove any stale listeners from a previous round before adding new ones
  canvas.removeEventListener('pointerdown',   onPointerDown);
  canvas.removeEventListener('pointermove',   onPointerMove);
  canvas.removeEventListener('pointerup',     onPointerUp);
  canvas.removeEventListener('pointerleave',  onPointerUp);
  canvas.removeEventListener('pointercancel', onPointerUp);

  // Size canvas to wrapper (showScreen must be called first for valid dimensions)
  const rect = wrapper.getBoundingClientRect();
  canvas.width  = rect.width  || 800;
  canvas.height = rect.height || 600;

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  isDrawing = false;

  canvas.addEventListener('pointerdown',   onPointerDown,  { passive: false });
  canvas.addEventListener('pointermove',   onPointerMove,  { passive: false });
  canvas.addEventListener('pointerup',     onPointerUp,    { passive: false });
  canvas.addEventListener('pointerleave',  onPointerUp,    { passive: false });
  canvas.addEventListener('pointercancel', onPointerUp,    { passive: false });
}

function getCanvasPos(e) {
  const canvas = document.getElementById('draw-canvas');
  const rect   = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / rect.width,
    y: (e.clientY - rect.top)  / rect.height,
  };
}

function drawLocalLine(x0, y0, x1, y1, color, size) {
  const canvas = document.getElementById('draw-canvas');
  const ctx    = canvas.getContext('2d');
  ctx.beginPath();
  ctx.moveTo(x0 * canvas.width,  y0 * canvas.height);
  ctx.lineTo(x1 * canvas.width,  y1 * canvas.height);
  ctx.strokeStyle = color;
  ctx.lineWidth   = size;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.stroke();
}

function drawLocalDot(x, y, color, size) {
  const canvas = document.getElementById('draw-canvas');
  const ctx    = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(x * canvas.width, y * canvas.height, size / 2, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function sendDrawEvent(event) {
  socket.emit('game:action', { type: 'draw_event', event });
}

function onPointerDown(e) {
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  isDrawing = true;
  const pos = getCanvasPos(e);
  lastX = pos.x; lastY = pos.y;
  drawLocalDot(pos.x, pos.y, drawColor, drawSize);
  sendDrawEvent({ type: 'dot', x: pos.x, y: pos.y, color: drawColor, size: drawSize });
}

function onPointerMove(e) {
  e.preventDefault();
  if (!isDrawing) return;
  const pos = getCanvasPos(e);
  drawLocalLine(lastX, lastY, pos.x, pos.y, drawColor, drawSize);
  sendDrawEvent({ type: 'line', x0: lastX, y0: lastY, x1: pos.x, y1: pos.y, color: drawColor, size: drawSize });
  lastX = pos.x; lastY = pos.y;
}

function onPointerUp(e) {
  e.preventDefault();
  isDrawing = false;
}

// Color swatches
document.querySelectorAll('.color-swatch').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.color-swatch').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    drawColor = btn.dataset.color;
    // Bump size for eraser
    if (drawColor === '#ffffff') drawSize = 20;
  });
});

// Size buttons
document.querySelectorAll('.size-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    drawSize = parseInt(btn.dataset.size, 10);
  });
});

// Clear
document.getElementById('btn-clear').addEventListener('click', () => {
  const canvas = document.getElementById('draw-canvas');
  const ctx    = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  sendDrawEvent({ type: 'clear' });
});

// Submit drawing
document.getElementById('btn-submit-drawing').addEventListener('click', () => {
  socket.emit('game:action', { type: 'submit_drawing' });
  showWaiting('🎨', 'Drawing submitted!', 'Others are guessing…');
});

// ── Error / close handling ─────────────────────────────────

socket.on('error', ({ message }) => {
  // Try to show error in the active err element, fall back to join error
  const joinErr = document.getElementById('join-err');
  if (document.getElementById('s-join').classList.contains('active')) {
    joinErr.textContent = message;
  } else {
    alert(message);
  }
});

socket.on('room:closed', ({ message }) => {
  alert(message);
  location.reload();
});

// Fix: canvas var referenced before initCanvas in event handlers
const canvas = document.getElementById('draw-canvas');
