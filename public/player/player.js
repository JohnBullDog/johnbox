'use strict';

const socket = io();

// ── State ──────────────────────────────────────────────────
let myPlayer    = null;
const SESSION_KEY = 'jb_session';
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

// ── Session / reconnect ────────────────────────────────────

socket.on('connect', () => {
  // Attempt to restore session on every connect (handles both page reload and auto-reconnect)
  const token = myPlayer?.sessionToken ?? (() => {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null')?.sessionToken; } catch { return null; }
  })();
  if (token) socket.emit('room:rejoin', { sessionToken: token });
});

socket.on('room:rejoined', ({ code, player, state }) => {
  myPlayer = player;
  localStorage.setItem(SESSION_KEY, JSON.stringify({ sessionToken: player.sessionToken }));
  document.getElementById('lobby-code-display').textContent = code;
  document.getElementById('lobby-name').textContent = player.name;
  document.getElementById('lobby-avatar').style.background = player.color;
  if (state === 'lobby') showScreen('s-lobby');
  // If state === 'playing', the server follows up with player:phase
});

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
  localStorage.setItem(SESSION_KEY, JSON.stringify({ sessionToken: player.sessionToken }));
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
  // Acknowledge receipt so the server stops retrying
  if (data._msgId != null) socket.emit('phase:ack', { msgId: data._msgId });

  // GSLS events are tagged game:'gsls' and handled by the GSLS listener below
  if (data.game === 'gsls') return;

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
  localStorage.removeItem(SESSION_KEY);
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
  if (!myPlayer) {
    // Error before/during session restore — clear stale session so join screen shows
    localStorage.removeItem(SESSION_KEY);
  }
  const joinErr = document.getElementById('join-err');
  if (document.getElementById('s-join').classList.contains('active')) {
    joinErr.textContent = message;
  } else {
    alert(message);
  }
});

socket.on('room:closed', ({ message }) => {
  localStorage.removeItem(SESSION_KEY);
  alert(message);
  location.reload();
});

// Fix: canvas var referenced before initCanvas in event handlers
const canvas = document.getElementById('draw-canvas');

// ═══════════════════════════════════════════════════════════
// TAG GAME — player handlers
// ═══════════════════════════════════════════════════════════

let tgWheelSegments  = null;
let tgWheelRotation  = 0;
let tgMyCallouts     = {};   // { "playerId:tag": true }
let tgAnimFrame      = null;

// ── Wheel draw ─────────────────────────────────────────────
// Same colour constants as host.js
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
  const ctx   = canvas.getContext('2d');
  const cx    = canvas.width  / 2;
  const cy    = canvas.height / 2;
  const r     = Math.min(cx, cy) - 5;
  const n     = segments.length;
  const arc   = (2 * Math.PI) / n;
  const off   = (rotationDeg * Math.PI / 180) - Math.PI / 2;
  const fs    = Math.max(10, Math.min(14, r * 0.075));
  const textR = r * 0.62;
  const maxW  = r * 0.52;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  segments.forEach((seg, i) => {
    const a0 = off + i * arc;
    const a1 = a0 + arc;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a0, a1);
    ctx.closePath();
    ctx.fillStyle = seg.type === 'event' ? TG_EVENT_COLOR : TG_SEG_COLORS[i % TG_SEG_COLORS.length];
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

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
    ctx.shadowBlur  = 3;
    ctx.fillStyle   = 'white';
    const lineH  = fs * 1.3;
    const startY = -(lines.length - 1) * lineH / 2;
    lines.forEach((ln, li) => ctx.fillText(ln, 0, startY + li * lineH));

    ctx.restore();
  });

  ctx.shadowBlur = 0;

  ctx.beginPath();
  ctx.arc(cx, cy, r + 1, 0, 2 * Math.PI);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, r + 4, 0, 2 * Math.PI);
  ctx.strokeStyle = '#7c4dff';
  ctx.lineWidth = 4;
  ctx.stroke();

  const hubR = Math.max(10, r * 0.07);
  ctx.beginPath();
  ctx.arc(cx, cy, hubR, 0, 2 * Math.PI);
  ctx.fillStyle = '#0f0f1a';
  ctx.fill();
  ctx.strokeStyle = '#7c4dff';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function tgSizeAndDrawWheel(segments, rotation) {
  const c = document.getElementById('tg-player-wheel');
  if (!c) return;
  const size = Math.min(c.parentElement.clientWidth, c.parentElement.clientHeight) || 280;
  c.width = size; c.height = size;
  tgDrawWheel(c, segments, rotation);
}

function tgAnimateSpin(segments, fromDeg, resultIndex, onDone) {
  if (tgAnimFrame) cancelAnimationFrame(tgAnimFrame);
  const n          = segments.length;
  const segDeg     = 360 / n;
  const segCenter  = resultIndex * segDeg + segDeg / 2;
  const adjustment = (360 - segCenter + 360) % 360;
  const targetDeg  = fromDeg + 5 * 360 + adjustment;
  const duration   = 4500;
  const start      = performance.now();

  const c = document.getElementById('tg-player-wheel');

  function frame(now) {
    const t     = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 5);
    const deg   = fromDeg + (targetDeg - fromDeg) * eased;
    tgDrawWheel(c, segments, deg);
    if (t < 1) {
      tgAnimFrame = requestAnimationFrame(frame);
    } else {
      tgWheelRotation = targetDeg % 360;
      if (onDone) onDone();
    }
  }
  tgAnimFrame = requestAnimationFrame(frame);
}

// TagGame phases are dispatched from the existing player:phase handler below

function tgHandleSpinReady(d) {
  tgWheelSegments = d.wheelSegments;
  tgMyCallouts    = {};

  const roundLabel = d.maxRounds > 1
    ? `Round ${d.roundNumber}/${d.maxRounds} · Turn ${d.turnInRound}/${d.playersPerRound}`
    : `Turn ${d.turnInRound}/${d.playersPerRound}`;

  if (d.role === 'spinner') {
    showScreen('s-tg-spin');
    tgSizeAndDrawWheel(d.wheelSegments, tgWheelRotation);
    tgRenderMyTags('tg-spin-my-tags', myPlayer?.id, d.allPlayers);
    document.querySelector('#s-tg-spin p').textContent = roundLabel + ' · Your turn!';
  } else {
    showScreen('s-tg-watch-spin');
    document.getElementById('tg-ws-title').textContent = `${esc(d.spinner.name)} is spinning…`;
    document.getElementById('tg-ws-sub').textContent   = roundLabel;
    tgRenderMyTags('tg-ws-my-tags', myPlayer?.id, d.allPlayers);
  }
}

function tgHandleSpinning(d) {
  tgWheelSegments = d.wheelSegments;

  if (d.role === 'spinner') {
    showScreen('s-tg-spin');
    tgSizeAndDrawWheel(d.wheelSegments, tgWheelRotation);
    tgAnimateSpin(d.wheelSegments, tgWheelRotation, d.resultIndex, () => {});
  } else {
    showScreen('s-tg-watch-spin');
    document.getElementById('tg-ws-title').textContent = `${esc(d.spinner.name)} is spinning!`;
    document.getElementById('tg-ws-sub').textContent   = 'Watch the big screen!';
    tgSizeAndDrawWheel(d.wheelSegments, tgWheelRotation);
    tgAnimateSpin(d.wheelSegments, tgWheelRotation, d.resultIndex, () => {});
  }
}

function tgHandleAdjResult(d) {
  showScreen('s-tg-adj-result');
  const isMe = myPlayer && d.spinner.id === myPlayer.id;
  document.getElementById('tg-ar-who').textContent = isMe ? 'You got:' : `${d.spinner.name} got:`;
  document.getElementById('tg-ar-tag').textContent = d.adjective;
  tgRenderMyTags('tg-ar-my-tags', myPlayer?.id, d.allPlayers);
}

function tgHandleEventResult(d) {
  showScreen('s-tg-event-result');
  const isMe = myPlayer && d.spinner.id === myPlayer.id;
  document.getElementById('tg-er-who').textContent  = isMe ? 'You landed on:' : `${d.spinner.name} landed on:`;
  document.getElementById('tg-er-icon').textContent = d.event.icon;
  document.getElementById('tg-er-name').textContent = d.event.name;
  document.getElementById('tg-er-desc').textContent = d.event.description;
}

function tgHandleEventResolve(d) {
  if (d.role === 'chooser') {
    showScreen('s-tg-event-choose');
    document.getElementById('tg-ec-title').textContent = `${d.event.icon} ${d.event.name}`;
    document.getElementById('tg-ec-sub').textContent   = d.event.description;

    const list = document.getElementById('tg-ec-options');

    if (d.event.needsChoice === 'player' && d.options) {
      // Pick a player
      list.innerHTML = d.options.map(p => `
        <button class="tg-choose-btn" onclick="tgChoosePlayer('${p.id}')">
          <span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${p.color};margin-right:8px;vertical-align:middle;"></span>
          ${esc(p.name)}
          <small style="color:var(--muted);"> — ${p.tags.join(', ') || 'no tags'}</small>
        </button>
      `).join('');
    } else if (d.event.needsChoice === 'adjective' && d.adjectives) {
      // Wildcard: pick any adjective
      list.innerHTML = d.adjectives.map(adj => `
        <button class="tg-choose-btn" onclick="tgChooseTag('${esc(adj)}')">${esc(adj)}</button>
      `).join('');
    }
  } else if (d.role === 'voter' && d.adjectives) {
    // Audience pick: suggest a tag for the spinner
    showScreen('s-tg-event-choose');
    document.getElementById('tg-ec-title').textContent = `${d.event.icon} Audience Choice!`;
    document.getElementById('tg-ec-sub').textContent   = `Suggest a tag for ${d.spinner.name}`;
    const list = document.getElementById('tg-ec-options');
    list.innerHTML = d.adjectives.map(adj => `
      <button class="tg-choose-btn" onclick="tgVoteTag('${esc(adj)}')">${esc(adj)}</button>
    `).join('');
  } else {
    showWaiting('⏳', 'Event resolving…', 'Wait for the action to happen');
  }
}

function tgHandleEventApplied(d) {
  tgRenderMyTags('tg-ws-my-tags', myPlayer?.id, d.allPlayers);
  showWaiting('✅', 'Tags updated!', 'Get ready for your task…');
}

function tgHandlePerfVote(d) {
  if (d.role === 'performer') {
    showWaiting('🎭', 'Skit over!', 'The audience is rating your performance…');
    return;
  }
  if (d.role === 'voted') {
    showWaiting('✅', `You rated: ${d.yourRating}/10`, 'Waiting for others…');
    return;
  }

  // voter — show rating grid
  showScreen('s-tg-perf-vote');

  const perfEl = document.getElementById('tg-pv-performers-player');
  perfEl.innerHTML = (d.performers || []).map(p =>
    `<span style="background:${p.color}44;border:2px solid ${p.color};border-radius:10px;padding:6px 12px;font-weight:700;font-size:14px;">${esc(p.name)}</span>`
  ).join('');

  // Rating colours: 1-2 red, 3-4 orange, 5-6 yellow, 7-8 lime, 9-10 green
  const colours = ['','#e63946','#e63946','#f4a261','#f4a261','#e9c46a','#e9c46a','#90be6d','#90be6d','#43aa8b','#2d9cdb'];
  const grid = document.getElementById('tg-rating-grid');
  grid.innerHTML = Array.from({ length: 10 }, (_, i) => {
    const n = i + 1;
    return `<button class="tg-rating-btn" style="background:${colours[n]};"
      onclick="tgCastRating(${n}, this)">${n}</button>`;
  }).join('');
}

function tgCastRating(rating, btn) {
  document.querySelectorAll('.tg-rating-btn').forEach(b => b.disabled = true);
  btn.style.outline = '3px solid white';
  socket.emit('game:action', { type: 'performance_vote', rating });
  showWaiting('✅', `You rated: ${rating}/10`, 'Waiting for others…');
}

function tgHandleTaskIntro(d) {
  showScreen('s-tg-task-intro');
  document.getElementById('tg-task-prompt').textContent = d.task.prompt;

  const perfEl = document.getElementById('tg-task-performers');
  perfEl.innerHTML = d.performers.map(p => `
    <span style="background:${p.color}44;border:2px solid ${p.color};border-radius:10px;padding:6px 12px;font-weight:700;font-size:14px;">
      ${esc(p.name)}${p.immune ? ' 🛡️' : ''}
    </span>
  `).join('');

  tgRenderMyTags('tg-task-my-tags', myPlayer?.id, d.allPlayers);
}

function tgHandleSkit(d) {
  const isPerformer = d.role === 'performer';

  if (isPerformer) {
    showScreen('s-tg-performing');
    document.getElementById('tg-perf-prompt').textContent = d.task.prompt;
    const tagsEl = document.getElementById('tg-perf-tags');
    tagsEl.innerHTML = (d.myTags || []).map(t =>
      `<div class="tg-tag-pill ${d.immune ? 'immune' : ''}">${esc(t)}${d.immune ? ' 🛡️' : ''}</div>`
    ).join('');
  } else {
    tgMyCallouts = d.myCallouts || {};
    showScreen('s-tg-vote');
    tgRenderVotePerformers(d.performers, d.calloutData, d.threshold, d.nonPerformerCount);
  }
}

function tgHandleSkitResult(d) {
  showScreen('s-tg-skit-result');
  const delta   = d.myDelta ?? 0;
  const myP     = d.allPlayers.find(p => myPlayer && p.id === myPlayer.id);
  const myPerf  = d.performerResults?.find(r => myPlayer && r.id === myPlayer.id);

  document.getElementById('tg-sr-delta').textContent = delta > 0 ? `+${delta}` : delta === 0 ? '—' : `${delta}`;
  document.getElementById('tg-sr-msg').textContent   = delta > 0 ? 'Nice work!' : 'Better luck next time!';

  let scoreLines = myP ? `Total: ${myP.score} pts` : '';
  if (myPerf) {
    scoreLines = `⭐ ${d.avgRating}/10 → +${myPerf.ratingPts}`;
    if (myPerf.immuneBonus) scoreLines += ` · 🛡️ +${myPerf.immuneBonus}`;
    if (myPerf.penalty)     scoreLines += ` · ❌ −${myPerf.penalty}`;
    scoreLines += `\nTotal: ${myP?.score ?? 0} pts`;
  }
  document.getElementById('tg-sr-score').textContent = scoreLines;

  const tagsEl = document.getElementById('tg-sr-tags');
  tagsEl.innerHTML = (myP?.tags || []).map(t => {
    const failed = myPerf?.failedTags?.includes(t);
    return `<div class="tg-tag-pill" style="${failed ? 'background:#7a1a1a;text-decoration:line-through;' : ''}">${esc(t)}${failed ? ' ❌' : ''}</div>`;
  }).join('') || '<span style="color:var(--muted);">No tags</span>';
}

function tgHandleGameOver(d) {
  localStorage.removeItem(SESSION_KEY);
  const medals = ['🥇','🥈','🥉'];
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

// Live callout re-renders are handled by the main player:phase handler above

// ── TagGame player actions ─────────────────────────────────

document.getElementById('tg-btn-spin').addEventListener('click', () => {
  document.getElementById('tg-btn-spin').disabled = true;
  socket.emit('game:action', { type: 'spin' });
});

function tgChoosePlayer(targetId) {
  document.querySelectorAll('.tg-choose-btn').forEach(b => b.disabled = true);
  socket.emit('game:action', { type: 'event_choice', targetId });
  showWaiting('✅', 'Choice made!', 'Waiting for event to resolve…');
}

function tgChooseTag(tag) {
  document.querySelectorAll('.tg-choose-btn').forEach(b => b.disabled = true);
  socket.emit('game:action', { type: 'event_choose_tag', tag });
  showWaiting('✅', 'Tag chosen!', 'Waiting…');
}

function tgVoteTag(tag) {
  document.querySelectorAll('.tg-choose-btn').forEach(b => b.disabled = true);
  socket.emit('game:action', { type: 'audience_vote', tag });
  showWaiting('✅', `You voted for: "${tag}"`, 'Waiting for everyone…');
}

function tgCalloutTag(targetId, tag) {
  const key = `${targetId}:${tag}`;
  if (tgMyCallouts[key]) return;
  tgMyCallouts[key] = true;
  // Update button immediately
  const btn = document.querySelector(`[data-callout-key="${key}"]`);
  if (btn) btn.classList.add('called-out');
  socket.emit('game:action', { type: 'callout_tag', targetId, tag });
}

// ── TagGame render helpers ─────────────────────────────────

function tgRenderMyTags(elId, myId, allPlayers) {
  const el = document.getElementById(elId);
  if (!el || !myId) return;
  const me = allPlayers?.find(p => p.id === myId);
  if (!me) return;
  el.innerHTML = (me.tags || []).map(t =>
    `<div class="tg-tag-pill ${me.immune ? 'immune' : ''}">${esc(t)}</div>`
  ).join('') || '<span style="color:var(--muted);font-size:13px;">No tags yet</span>';
}

function tgRenderVotePerformers(performers, calloutData, threshold, nonPerformerCount) {
  const el = document.getElementById('tg-vote-performers');
  if (!el) return;
  el.innerHTML = performers.map(p => {
    const tagBtns = p.tags.map(tag => {
      const key    = `${p.id}:${tag}`;
      const entry  = calloutData?.[key];
      const count  = entry?.count || 0;
      const failed = entry?.failed || false;
      const myVote = tgMyCallouts?.[key];
      const cls    = failed ? 'failed-tag' : myVote ? 'called-out' : '';
      return `
        <button class="tg-callout-btn ${cls}"
          data-callout-key="${key}"
          ${failed || myVote ? 'disabled' : ''}
          onclick="tgCalloutTag('${p.id}', '${esc(tag)}')">
          <span>${esc(tag)}</span>
          <span class="tg-call-count">${count}/${threshold}${failed ? ' ❌' : ''}</span>
        </button>
      `;
    }).join('');
    return `
      <div class="tg-performer-section">
        <div class="tg-perf-name" style="color:${p.color}">${esc(p.name)} ${p.immune ? '🛡️' : ''}</div>
        ${tagBtns || '<p style="color:var(--muted);font-size:13px;">No tags to call out</p>'}
      </div>
    `;
  }).join('');
}

// ═══════════════════════════════════════════════════════════
// GSLS — General Statement's Last Stand player handlers
// ═══════════════════════════════════════════════════════════

let gslsMyRole      = null;   // 'speaker'|'aide'|'audience'|'debater'
let gslsMyNet       = 0;      // personal reaction net
let gslsAideDrawing = false;
let gslsAideLastX   = 0, gslsAideLastY = 0;
let gslsAideColor   = '#1a1a1a';
let gslsAideSize    = 6;

// ── Forbidden word pill helper ──────────────────────────────

function gslsForbiddenPills(words) {
  return (words || []).map(w =>
    `<span style="background:#3a1a1a;color:#ff6b6b;border:1px solid #ff6b6b;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:700;">${esc(w)}</span>`
  ).join('');
}

function gslsNapkinHtml(napkin) {
  return `<div style="border-radius:8px;overflow:hidden;border:2px solid #ffeaa7;max-width:300px;">
    <div style="font-size:10px;background:#ffeaa7;color:#1a1a1a;padding:3px 8px;font-weight:700;">📜 Napkin #${napkin.index + 1}</div>
    <img src="${napkin.imageData}" style="width:100%;display:block;" />
  </div>`;
}

function gslsHeckleList(heckles) {
  return (heckles || []).map(h =>
    `<div style="background:var(--card);border-radius:8px;padding:10px 14px;font-style:italic;font-size:14px;">"${esc(h)}"</div>`
  ).join('');
}

// ── Phase routing ───────────────────────────────────────────

socket.on('player:phase', (data) => {
  if (data.game !== 'gsls') return;

  switch (data.phase) {
    case 'turn_setup':        gslsHandleSetup(data);        break;
    case 'prep':              gslsHandlePrep(data);         break;
    case 'part1':             gslsHandlePart1(data);        break;
    case 'part2':             gslsHandlePart2(data);        break;
    case 'part3':             gslsHandlePart3(data);        break;
    case 'part3_respond':     gslsHandlePart3Respond(data); break;
    case 'voting':            gslsHandleVoting(data);       break;
    case 'reveal':            gslsHandleReveal(data);       break;
    case 'last_stand_intro':  gslsHandleLsIntro(data);      break;
    case 'last_stand_prep':   gslsHandleLsPrep(data);       break;
    case 'last_stand_debate': gslsHandleLsDebate(data);     break;
    case 'last_stand_heckle': gslsHandleLsHeckle(data);     break;
    case 'last_stand_challenge': gslsHandleLsChallenge(data); break;
    case 'last_stand_voting': gslsHandleLsVoting(data);     break;
    case 'last_stand_reveal': gslsHandleLsReveal(data);     break;
  }
});

function gslsHandleSetup(d) {
  gslsMyRole = d.role;
  gslsMyNet  = 0;
  showScreen('s-gsls-setup');
  document.getElementById('gsls-setup-title').textContent =
    `Turn ${d.turnNumber}/${d.totalTurns}`;

  const desc = d.role === 'speaker' ? '🎙️ You are the Speaker this round!'
             : d.role === 'aide'    ? '✏️ You are the Aide this round!'
             : `🎙️ ${esc(d.speakerName)} is speaking`;
  document.getElementById('gsls-setup-role-desc').textContent = desc;

  const detail = d.role === 'speaker'
    ? `Your aide is <strong style="color:${d.aideColor}">${esc(d.aideName)}</strong>. They will pass you napkins.`
    : d.role === 'aide'
    ? `You will see both prompts. Draw hints and pass napkins to <strong style="color:#4ecdc4">${esc(d.speakerName)}</strong>.`
    : `<strong>${esc(d.speakerName)}</strong> is speaking. Use cheer 👏 and boo 👎 to react.`;
  document.getElementById('gsls-setup-detail').innerHTML = detail;
}

function gslsHandlePrep(d) {
  gslsMyRole = d.role;
  if (d.role === 'speaker') {
    showScreen('s-gsls-speaker-prep');
    document.getElementById('gsls-sp-prompt').textContent = d.promptText;
    document.getElementById('gsls-sp-forbidden').innerHTML = gslsForbiddenPills(d.forbidden);
    document.getElementById('gsls-sp-timer').textContent = d.timeLeft;
  } else if (d.role === 'aide') {
    showScreen('s-gsls-aide');
    document.getElementById('gsls-aide-true').textContent  = d.truePromptText;
    document.getElementById('gsls-aide-decoy').textContent = d.decoyPromptText;
    document.getElementById('gsls-aide-speaker-name').textContent = d.speakerName;
    document.getElementById('gsls-aide-napkin-count').textContent = '0 sent';
    gslsInitAideCanvas();
  } else {
    showScreen('s-gsls-audience');
    document.getElementById('gsls-aud-topic').textContent = d.truePromptText;
    document.getElementById('gsls-aud-phase-label').textContent = 'Speaker is preparing…';
    document.getElementById('gsls-aud-my-net').textContent = 'Cheer/boo activates soon';
    document.getElementById('gsls-btn-cheer').disabled = true;
    document.getElementById('gsls-btn-boo').disabled   = true;
  }
}

function gslsHandlePart1(d) {
  gslsMyRole = d.role;
  if (d.role === 'speaker') {
    showScreen('s-gsls-speaker-active');
    document.getElementById('gsls-sa-forbidden-banner').innerHTML =
      `⚠️ FORBIDDEN: ${gslsForbiddenPills(d.forbidden)}`;
    document.getElementById('gsls-sa-prompt').textContent = d.promptText;
    document.getElementById('gsls-sa-timer').textContent  = d.timeLeft;
    // Show any napkins already received
    const nc = document.getElementById('gsls-napkins');
    nc.innerHTML = (d.napkins || []).map(gslsNapkinHtml).join('');
    document.getElementById('gsls-napkin-label').style.display = d.napkins?.length ? 'block' : 'none';
  } else if (d.role === 'aide') {
    showScreen('s-gsls-aide');
    document.getElementById('gsls-aide-true').textContent  = d.truePromptText;
    document.getElementById('gsls-aide-decoy').textContent = d.decoyPromptText;
    document.getElementById('gsls-aide-napkin-count').textContent = (d.napkinsSent || 0) + ' sent';
  } else {
    showScreen('s-gsls-audience');
    document.getElementById('gsls-aud-topic').textContent = d.truePromptText;
    document.getElementById('gsls-aud-phase-label').textContent = '🗣️ Part 1 — Forbidden words active on speaker\'s side!';
    document.getElementById('gsls-aud-my-net').textContent = 'Your reaction: 0';
    document.getElementById('gsls-btn-cheer').disabled = false;
    document.getElementById('gsls-btn-boo').disabled   = false;
  }
}

function gslsHandlePart2(d) {
  gslsMyRole = d.role;
  if (d.role === 'speaker') {
    showScreen('s-gsls-speaker-active');
    document.getElementById('gsls-sa-forbidden-banner').innerHTML =
      `<span style="color:var(--teal);">✅ Forbidden words lifted — speak freely!</span>`;
    document.getElementById('gsls-sa-forbidden-banner').style.background = '#1a3a2a';
    document.getElementById('gsls-sa-forbidden-banner').style.borderColor = 'var(--teal)';
    document.getElementById('gsls-sa-prompt').textContent = d.promptText;
    document.getElementById('gsls-sa-timer').textContent  = d.timeLeft;
    const nc = document.getElementById('gsls-napkins');
    nc.innerHTML = (d.napkins || []).map(gslsNapkinHtml).join('');
  } else if (d.role === 'aide') {
    showScreen('s-gsls-aide');
    document.getElementById('gsls-aide-napkin-count').textContent = (d.napkinsSent || 0) + ' sent';
  } else {
    showScreen('s-gsls-audience');
    document.getElementById('gsls-aud-phase-label').textContent = '🗣️ Part 2 — Forbidden words lifted';
    document.getElementById('gsls-btn-cheer').disabled = false;
    document.getElementById('gsls-btn-boo').disabled   = false;
  }
}

function gslsHandlePart3(d) {
  gslsMyRole = d.role;
  if (d.role === 'speaker') {
    showScreen('s-gsls-speaker-heckle-wait');
  } else if (d.role === 'aide') {
    showWaiting('✏️', 'Audience writing questions', `You sent ${d.napkinsSent || 0} napkins — great work!`);
  } else {
    showScreen('s-gsls-heckle');
    document.getElementById('gsls-heckle-input').value = '';
    document.getElementById('gsls-heckle-err').textContent = '';
  }
}

function gslsHandlePart3Respond(d) {
  gslsMyRole = d.role;
  if (d.role === 'speaker') {
    showScreen('s-gsls-speaker-challenge');
    document.getElementById('gsls-sc-prompt').textContent = d.promptText;
    document.getElementById('gsls-sc-heckles').innerHTML  = gslsHeckleList(d.heckles);
    document.getElementById('gsls-sc-timer').textContent  = d.timeLeft;
    const nc = document.getElementById('gsls-sc-napkins');
    nc.innerHTML = (d.napkins || []).map(gslsNapkinHtml).join('');
  } else if (d.role === 'aide') {
    showWaiting('✏️', 'Speaker is responding', gslsHeckleList(d.heckles) ? 'Questions are live on the big screen' : '');
  } else {
    // Audience already submitted heckle — show waiting or cheer/boo
    if (d.role === 'audience') {
      showScreen('s-gsls-heckle-wait');
      document.getElementById('gsls-heckle-wait-text').innerHTML =
        gslsHeckleList(d.heckles) || 'Speaker is responding to questions…';
    }
  }
}

function gslsHandleVoting(d) {
  gslsMyRole = d.role;
  if (d.role === 'voter') {
    showScreen('s-gsls-vote');
    document.getElementById('gsls-vote-speaker-name').textContent =
      `Did ${d.speakerName} have the true prompt or a decoy?`;
  } else {
    showWaiting('🗳️', 'Audience is voting…', d.role === 'speaker' ? 'Did they believe you?' : 'Did the speaker fool them?');
  }
}

function gslsHandleReveal(d) {
  showScreen('s-gsls-reveal');
  const hadLabel = d.speakerHadTrue ? '🎯 TRUE Prompt' : '🎭 DECOY Prompt';
  const hadColor = d.speakerHadTrue ? 'var(--teal)' : 'var(--coral)';
  document.getElementById('gsls-rev-headline').innerHTML =
    `${esc(d.speakerName)} had the <span style="color:${hadColor}">${hadLabel}</span>!`;
  document.getElementById('gsls-rev-true-text').textContent  = d.truePromptText;
  document.getElementById('gsls-rev-decoy-text').textContent = d.decoyPromptText;

  let resultHtml = '';
  if (d.myRole === 'speaker') {
    resultHtml = `You scored <strong style="color:var(--teal);">+${d.speakerScore}</strong>`;
    if (d.deceptionBonus) resultHtml += ` <span style="color:var(--teal);">+${d.deceptionBonus} Deception Bonus!</span>`;
  } else if (d.myRole === 'aide') {
    resultHtml = `Aide bonus: <strong style="color:#ffeaa7;">+${d.aideScore}</strong>`;
  } else {
    const correct = d.myGuessCorrect;
    const voteLabel = d.myVote === 'true' ? 'True Prompt' : 'Decoy Prompt';
    resultHtml = `You voted: ${voteLabel} — ${correct ? '✅ Correct! +50' : '❌ Wrong'}`;
  }
  document.getElementById('gsls-rev-result').innerHTML = resultHtml;
  document.getElementById('gsls-rev-my-score').textContent = `Total: ${d.myScore} pts`;
}

// ── Last Stand ──────────────────────────────────────────────

function gslsHandleLsIntro(d) {
  gslsMyRole = d.role;
  if (d.role === 'debater') {
    showScreen('s-gsls-debater');
    document.getElementById('gsls-deb-prompt').textContent = 'Your prompt loading…';
    document.getElementById('gsls-deb-sub').textContent = 'Get ready — you\'re debating!';
    document.getElementById('gsls-deb-forbidden').innerHTML = '';
  } else {
    showScreen('s-gsls-ls-watch');
    document.getElementById('gsls-ls-debaters-display').innerHTML = `
      <div style="background:${d.debater1Color}22;border:2px solid ${d.debater1Color};border-radius:10px;padding:10px 16px;font-weight:700;color:${d.debater1Color};">${esc(d.debater1Name)}</div>
      <div style="font-size:20px;align-self:center;font-weight:900;">VS</div>
      <div style="background:${d.debater2Color}22;border:2px solid ${d.debater2Color};border-radius:10px;padding:10px 16px;font-weight:700;color:${d.debater2Color};">${esc(d.debater2Name)}</div>`;
  }
}

function gslsHandleLsPrep(d) {
  if (d.role === 'debater') {
    showScreen('s-gsls-debater');
    document.getElementById('gsls-deb-prompt').textContent    = d.promptText;
    document.getElementById('gsls-deb-forbidden').innerHTML   = gslsForbiddenPills(d.forbidden);
    document.getElementById('gsls-deb-sub').textContent       = `You are debating against ${d.opponentName}`;
    document.getElementById('gsls-deb-timer').textContent     = d.timeLeft;
  } else {
    showWaiting('📋', 'Debaters are preparing…', 'They each have a different topic. Neither knows the other\'s.');
  }
}

function gslsHandleLsDebate(d) {
  if (d.role === 'debater') {
    showScreen('s-gsls-debater');
    document.getElementById('gsls-deb-prompt').textContent  = d.promptText;
    document.getElementById('gsls-deb-forbidden').innerHTML = gslsForbiddenPills(d.forbidden);
    document.getElementById('gsls-deb-sub').textContent     = '⚔️ Debate is live — SPEAK!';
    document.getElementById('gsls-deb-timer').textContent   = d.timeLeft;
  } else {
    showScreen('s-gsls-ls-watch');
    document.getElementById('gsls-ls-timer').textContent = d.timeLeft;
  }
}

function gslsHandleLsHeckle(d) {
  if (d.role === 'debater') {
    showWaiting('⏳', 'Audience writing questions', 'Almost there…');
  } else {
    showScreen('s-gsls-heckle');
    document.getElementById('gsls-heckle-input').value = '';
    document.getElementById('gsls-heckle-err').textContent = '';
  }
}

function gslsHandleLsChallenge(d) {
  if (d.role === 'debater') {
    showScreen('s-gsls-debater');
    document.getElementById('gsls-deb-prompt').textContent  = d.promptText;
    document.getElementById('gsls-deb-forbidden').innerHTML = gslsForbiddenPills(d.forbidden);
    document.getElementById('gsls-deb-sub').textContent     = 'Respond to a question!';
    document.getElementById('gsls-deb-timer').textContent   = d.timeLeft;
    // Show heckles below
    const existing = document.getElementById('gsls-deb-forbidden');
    const hDiv = document.createElement('div');
    hDiv.innerHTML = gslsHeckleList(d.heckles);
    existing.parentNode.insertBefore(hDiv, existing.nextSibling);
  } else {
    showScreen('s-gsls-heckle-wait');
    document.getElementById('gsls-heckle-wait-text').innerHTML =
      `Debaters are responding to questions`;
  }
}

function gslsHandleLsVoting(d) {
  if (d.role === 'waiting') {
    showWaiting('🗳️', 'Audience is voting…', 'Who argued better?');
  } else {
    showScreen('s-gsls-ls-vote');
    const btns = document.getElementById('gsls-ls-vote-btns');
    btns.innerHTML = [d.debater1, d.debater2].map(debater => `
      <button class="btn btn-primary" style="padding:18px;font-size:16px;font-weight:900;background:${debater.color};"
        onclick="gslsVoteWinner('${debater.id}')">
        ${esc(debater.name)}
      </button>`
    ).join('');
  }
}

function gslsHandleLsReveal(d) {
  showScreen('s-gsls-ls-reveal');
  const winner = d.iWon ? 'You won! 🏆' :
    (d.myRole === 'debater' ? 'You lost this one.' : `${esc([d.debater1, d.debater2].find(x => x.id === d.winnerId)?.name)} won!`);
  document.getElementById('gsls-ls-rev-winner').textContent = winner;
  document.getElementById('gsls-ls-rev-prompts').innerHTML = [d.debater1, d.debater2].map(deb =>
    `<div style="background:${deb.id === d.winnerId ? '#1a3a2a' : 'var(--card)'};border-left:4px solid ${deb.color};padding:12px;border-radius:8px;">
      <div style="font-size:11px;color:var(--muted);font-weight:700;margin-bottom:4px;">${esc(deb.name)} was arguing about… (${deb.votes} vote${deb.votes !== 1 ? 's' : ''})</div>
      <div style="font-size:14px;font-weight:600;">${esc(deb.prompt)}</div>
    </div>`
  ).join('');
  document.getElementById('gsls-ls-rev-my-score').textContent = `Your total: ${d.myScore} pts`;
}

// ── Actions ──────────────────────────────────────────────────

function gslsReact(type) {
  socket.emit('game:action', { type });
  gslsMyNet += type === 'cheer' ? 1 : -1;
  const capped = Math.max(-5, Math.min(5, gslsMyNet));
  document.getElementById('gsls-aud-my-net').textContent =
    `Your reaction: ${capped >= 0 ? '+' : ''}${capped} / ±5`;
  const btn = document.getElementById(type === 'cheer' ? 'gsls-btn-cheer' : 'gsls-btn-boo');
  btn.style.transform = 'scale(1.3)';
  setTimeout(() => { btn.style.transform = 'scale(1)'; }, 100);
}

function gslsSubmitHeckle() {
  const text = document.getElementById('gsls-heckle-input').value.trim();
  if (!text) { document.getElementById('gsls-heckle-err').textContent = 'Write something!'; return; }
  socket.emit('game:action', { type: 'submit_heckle', text });
  showScreen('s-gsls-heckle-wait');
}

function gslsCastVote(vote) {
  socket.emit('game:action', { type: 'submit_vote', vote });
  showScreen('s-gsls-voted');
}

function gslsVoteWinner(winnerId) {
  document.querySelectorAll('#gsls-ls-vote-btns button').forEach(b => b.disabled = true);
  socket.emit('game:action', { type: 'last_stand_vote', winnerId });
  showScreen('s-gsls-ls-voted');
  document.getElementById('gsls-ls-voted-msg').textContent = 'Vote cast!';
}

// ── Incoming napkin (delivered to speaker) ───────────────────

socket.on('gsls:napkin', (napkin) => {
  const containers = ['gsls-napkins','gsls-sc-napkins'];
  containers.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.insertAdjacentHTML('beforeend', gslsNapkinHtml(napkin));
  });
  document.getElementById('gsls-napkin-label').style.display = 'block';
});

// ── Timer updates ────────────────────────────────────────────

socket.on('timer', ({ timeLeft }) => {
  ['gsls-sp-timer','gsls-sa-timer','gsls-sc-timer','gsls-deb-timer','gsls-ls-timer'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.closest('.screen')?.classList.contains('active')) el.textContent = timeLeft;
  });
});

// ── Aide canvas ───────────────────────────────────────────────

function gslsInitAideCanvas() {
  const canvas = document.getElementById('gsls-aide-draw-canvas');
  if (!canvas) return;
  const wrapper = canvas.parentElement;
  const size = Math.min(wrapper.clientWidth || 340, 340);
  canvas.width  = size;
  canvas.height = Math.round(size * 0.6);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  canvas.removeEventListener('pointerdown', gslsPointerDown);
  canvas.removeEventListener('pointermove', gslsPointerMove);
  canvas.removeEventListener('pointerup',   gslsPointerUp);
  canvas.removeEventListener('pointerleave',gslsPointerUp);
  canvas.addEventListener('pointerdown', gslsPointerDown, { passive: false });
  canvas.addEventListener('pointermove', gslsPointerMove, { passive: false });
  canvas.addEventListener('pointerup',   gslsPointerUp,   { passive: false });
  canvas.addEventListener('pointerleave',gslsPointerUp,   { passive: false });
}

function gslsAidePos(e) {
  const c = document.getElementById('gsls-aide-draw-canvas');
  const r = c.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

function gslsPointerDown(e) {
  e.preventDefault();
  document.getElementById('gsls-aide-draw-canvas').setPointerCapture(e.pointerId);
  gslsAideDrawing = true;
  const p = gslsAidePos(e);
  gslsAideLastX = p.x; gslsAideLastY = p.y;
  gslsAideDrawLocal({ type: 'dot', x: p.x, y: p.y, color: gslsAideColor, size: gslsAideSize });
  socket.emit('game:action', { type: 'aide_draw', event: { type: 'dot', x: p.x, y: p.y, color: gslsAideColor, size: gslsAideSize } });
}

function gslsPointerMove(e) {
  e.preventDefault();
  if (!gslsAideDrawing) return;
  const p = gslsAidePos(e);
  gslsAideDrawLocal({ type: 'line', x0: gslsAideLastX, y0: gslsAideLastY, x1: p.x, y1: p.y, color: gslsAideColor, size: gslsAideSize });
  socket.emit('game:action', { type: 'aide_draw', event: { type: 'line', x0: gslsAideLastX, y0: gslsAideLastY, x1: p.x, y1: p.y, color: gslsAideColor, size: gslsAideSize } });
  gslsAideLastX = p.x; gslsAideLastY = p.y;
}

function gslsPointerUp(e) { e.preventDefault(); gslsAideDrawing = false; }

function gslsAideDrawLocal(ev) {
  const canvas = document.getElementById('gsls-aide-draw-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (ev.type === 'line') {
    ctx.beginPath(); ctx.moveTo(ev.x0*w, ev.y0*h); ctx.lineTo(ev.x1*w, ev.y1*h);
    ctx.strokeStyle = ev.color; ctx.lineWidth = ev.size; ctx.stroke();
  } else if (ev.type === 'dot') {
    ctx.beginPath(); ctx.arc(ev.x*w, ev.y*h, ev.size/2, 0, Math.PI*2);
    ctx.fillStyle = ev.color; ctx.fill();
  } else if (ev.type === 'clear') {
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, w, h);
  }
}

document.getElementById('gsls-aide-clear')?.addEventListener('click', () => {
  gslsAideDrawLocal({ type: 'clear' });
  socket.emit('game:action', { type: 'aide_draw', event: { type: 'clear' } });
});

document.getElementById('gsls-aide-send')?.addEventListener('click', () => {
  const canvas = document.getElementById('gsls-aide-draw-canvas');
  if (!canvas) return;
  const imageData = canvas.toDataURL('image/png');
  socket.emit('game:action', { type: 'send_napkin', imageData });
  // Clear canvas for next napkin
  gslsAideDrawLocal({ type: 'clear' });
  const cnt = document.getElementById('gsls-aide-napkin-count');
  const n = parseInt(cnt.textContent) + 1 || 1;
  cnt.textContent = `${n} sent`;
  // Pulse the button
  const btn = document.getElementById('gsls-aide-send');
  btn.textContent = '✅ Napkin sent!';
  setTimeout(() => { btn.textContent = '📜 Pass Napkin'; }, 1500);
});

// Aide color swatches within the aide screen
document.querySelectorAll('#s-gsls-aide .color-swatch').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#s-gsls-aide .color-swatch').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    gslsAideColor = btn.dataset.color;
    if (gslsAideColor === '#ffffff') gslsAideSize = 20;
    else gslsAideSize = 6;
  });
});
