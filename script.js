/* ============================================================
 * STORI — Multimodal AI Assistant
 * Don Bosco Institute of Technology · Dept. of Computer Engineering
 * Track 2, Group 5 · Experiment 5
 *
 * Vanilla ES module. No build step. Loads MediaPipe + Web Speech
 * from CDN. Everything runs on-device.
 *
 * FILE MAP
 *   1. State + helpers
 *   2. Screen navigation + step indicator
 *   3. Accessibility (high-contrast, reduced-motion, SR live)
 *   4. Logging
 *   5. Confidence engine (core of the project)
 *   6. Gesture: MediaPipe Hands
 *   7. Voice: Web Speech API
 *   8. Eye-tracking: MediaPipe Face Mesh + calibration + dwell
 *   9. Demo media player (the thing commands act on)
 *  10. Simulate mode (safety net)
 *  11. Wire-up per screen
 * ============================================================ */

// ---- 1. State + helpers -------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const TOTAL_SCREENS = 5;

/** Central app state. Single source of truth for modalities. */
const state = {
  screen: 1,
  persona: "aurora",
  threshold: 75,           // user-adjustable, %
  noisy: false,            // simulate noisy environment -> caps gesture/voice
  simulate: false,         // simulate mode (no camera/mic)
  permissions: { gesture: "idle", voice: "idle", eye: "idle" }, // idle|granted|denied|sim
  confidences: { gesture: 0, voice: 0, eye: 0 },
  commands: { gesture: null, voice: null, eye: null }, // last detected command per modality
  pending: null,           // the candidate command chosen by the engine, awaiting confirm
  lastExecuted: null,      // summary of last executed command (for screen 5)
  log: [],                 // event log (in-memory)
  // eye tracking
  calibration: [],         // [{ iris, screen }] x5
  gaze: { x: 0, y: 0, active: false },
  dwell: { target: null, started: 0, timer: null },
  // handles
  hands: null,
  faceMesh: null,
  camera: null,
  stream: null,
  recognition: null,
  rafId: null,
};

const COMMANDS = {
  wake:        { label: "Wake",        affects: "wake" },
  mute:        { label: "Mute",        affects: "mute" },
  unmute:      { label: "Unmute",      affects: "mute" },
  "volume up": { label: "Volume Up",  affects: "volume" },
  "volume down": { label: "Volume Down", affects: "volume" },
  pause:       { label: "Pause",      affects: "play" },
  play:        { label: "Play",        affects: "play" },
  "open browser": { label: "Open Browser", affects: "browser" },
};

/** Confidence engine configuration.
 * Threshold below which we won’t auto-execute, and the auto-fallback
 * floor (if the top two modalities are BOTH below this, switch to eye). */
const ENGINE = {
  fallbackFloor: 60,   // %
  dwellMs: 2000,       // dwell-to-select for gaze
};

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const nowMs = () => performance.now();
const fmtTime = (d = new Date()) =>
  d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Announce to screen readers. */
const sr = $("#sr-live");
function announce(msg) {
  if (sr) sr.textContent = msg;
}

// ---- 2. Screen navigation ----------------------------------
const screens = $$("section.screen");
const indicator = $("#step-indicator");

function buildIndicator() {
  indicator.innerHTML = "";
  for (let i = 1; i <= TOTAL_SCREENS; i++) {
    const li = document.createElement("li");
    li.className = "step";
    li.textContent = String(i);
    li.setAttribute("aria-label", `Step ${i} of ${TOTAL_SCREENS}`);
    indicator.appendChild(li);
  }
  updateIndicator();
}

function updateIndicator() {
  $$(".step", indicator).forEach((el, idx) => {
    const i = idx + 1;
    el.classList.toggle("is-active", i === state.screen);
    el.classList.toggle("is-done", i < state.screen);
  });
  // Update the visible "Step X of 5" affordance via aria on header
  indicator.setAttribute("aria-label", `Step ${state.screen} of ${TOTAL_SCREENS}`);
}

/** Show a screen by number (1..5). */
function goScreen(n) {
  if (n < 1 || n > TOTAL_SCREENS) return;
  state.screen = n;
  screens.forEach((s) => {
    const active = Number(s.dataset.screen) === n;
    s.classList.toggle("is-active", active);
    s.hidden = !active;
  });
  updateIndicator();
  // move focus into the screen for AT users
  const target = screens.find((s) => Number(s.dataset.screen) === n);
  if (target) {
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  }
  $("#main").scrollIntoView({ behavior: "smooth", block: "start" });
  announce(`Step ${n} of ${TOTAL_SCREENS}.`);

  // pause camera work when leaving live screen
  if (n !== 3) stopLiveLoop();
  if (n === 3) startLiveLoop();
  if (n === 4) setupConfirmScreen();
}

// delegate forward/back buttons
document.addEventListener("click", (e) => {
  const next = e.target.closest("[data-next]");
  if (next) { goScreen(Number(next.dataset.next)); return; }
  const back = e.target.closest("[data-back]");
  if (back) { goScreen(state.screen - 1); return; }
});

// ---- 3. Accessibility toggles -------------------------------
const hcToggle = $("#hc-toggle");
hcToggle.addEventListener("click", () => {
  const on = document.documentElement.classList.toggle("hc");
  hcToggle.setAttribute("aria-pressed", String(on));
  announce(on ? "High-contrast on." : "High-contrast off.");
});

// respect prefers-reduced-motion and expose a class for manual toggle
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  document.documentElement.classList.add("reduce-motion");
}

// ---- 4. Logging ---------------------------------------------
function logEvent(entry) {
  const e = {
    time: fmtTime(),
    modality: entry.modality ?? "—",
    command: entry.command ?? "—",
    confidence: entry.confidence ?? 0,
    result: entry.result ?? "ok",     // ok | fail | fallback
    fallback: !!entry.fallback,
    note: entry.note ?? "",
  };
  state.log.unshift(e);
  if (state.log.length > 50) state.log.pop();
  renderLog();
}

function renderLog() {
  const ul = $("#log-list");
  if (!ul) return;
  const items = state.log.slice(0, 5);
  ul.innerHTML = items
    .map(
      (e) => `
      <li>
        <span class="log__t">${e.time}</span>
        <span class="log__m">${e.modality} · ${e.command}${e.note ? ` <em>(${e.note})</em>` : ""}</span>
        <span class="log__c">${e.confidence}%</span>
        <span class="log__tag ${e.fallback ? "log__tag--fb" : e.result === "fail" ? "log__tag--fail" : "log__tag--ok"}">
          ${e.fallback ? "fallback" : e.result}
        </span>
      </li>`
    )
    .join("");
}

// ---- 5. Confidence engine (CORE) ----------------------------
/* The confidence engine decides which modality to act on.
 *
 * Inputs: three live confidence scores (gesture, voice, eye) and the
 *         per-modality last-detected command.
 * Rules:
 *   - Pick the modality with the highest confidence that also has a
 *     non-null command.
 *   - If that winner’s confidence >= state.threshold, mark it READY
 *     to execute (the user still confirms on screen 4).
 *   - If both gesture and voice are below ENGINE.fallbackFloor, the
 *     engine forces eye-tracking as the active modality and raises a
 *     banner (auto-fallback).
 *   - If two modalities tie (within 5%), the higher-priority one in
 *     the hierarchy [gesture, voice, eye] wins and a conflict is logged.
 *
 * The engine is recomputed whenever any confidence or command changes.
 */
function computeEngine() {
  const { confidences, commands, threshold, noisy } = state;

  // apply noise penalty: simulate noisy environment drags gesture+voice down
  let g = confidences.gesture;
  let v = confidences.voice;
  let e = confidences.eye;
  if (noisy) { g = Math.min(g, 55); v = Math.min(v, 55); }

  // candidate modalities that actually have a command right now
  const cands = [
    { modality: "gesture", conf: g, cmd: commands.gesture },
    { modality: "voice", conf: v, cmd: commands.voice },
    { modality: "eye", conf: e, cmd: commands.eye },
  ].filter((c) => c.cmd && c.conf > 0);

  let winner = null;
  let conflictLogged = false;
  if (cands.length > 1) {
    // sort by confidence desc, then by hierarchy
    const hierarchy = ["gesture", "voice", "eye"];
    cands.sort((a, b) => b.conf - a.conf || hierarchy.indexOf(a.modality) - hierarchy.indexOf(b.modality));
    if (Math.abs(cands[0].conf - cands[1].conf) <= 5) {
      conflictLogged = true;
      logEvent({
        modality: `${cands[0].modality}/${cands[1].modality}`,
        command: cands[0].cmd,
        confidence: Math.round((cands[0].conf + cands[1].conf) / 2),
        result: "ok",
        note: "conflict, picked higher priority",
      });
    }
    winner = cands[0];
  } else if (cands.length === 1) {
    winner = cands[0];
  }

  // auto-fallback: gesture & voice both below floor -> force eye
  let autoFallback = false;
  if (g < ENGINE.fallbackFloor && v < ENGINE.fallbackFloor && e >= ENGINE.fallbackFloor) {
    autoFallback = true;
    if (winner && winner.modality !== "eye") {
      // eye takes over
      winner = { modality: "eye", conf: e, cmd: commands.eye ?? "unmute" };
    } else if (!winner && commands.eye) {
      winner = { modality: "eye", conf: e, cmd: commands.eye };
    }
  }

  // is the winner executable?
  const ready = winner && winner.conf >= threshold;

  // banner
  const banner = $("#fallback-banner");
  const bannerText = $("#fallback-banner-text");
  if (autoFallback) {
    banner.hidden = false;
    bannerText.textContent =
      "Both gesture and voice are below 60%. Auto-switched to Eye-Tracking.";
  } else {
    banner.hidden = true;
  }

  // detected command box
  const det = $("#detected-command");
  const via = $("#detected-via");
  if (winner) {
    det.textContent = COMMANDS[winner.cmd]?.label ?? winner.cmd;
    via.textContent = `via ${winner.modality} · ${Math.round(winner.conf)}%${ready ? " · ready" : " · below threshold"}`;
  } else {
    det.textContent = "—";
    via.textContent = "";
  }

  // highlight the best meter
  $$(".meter").forEach((m) => {
    const k = m.dataset.meter;
    const val = k === "gesture" ? g : k === "voice" ? v : e;
    m.classList.toggle("is-best", !!winner && winner.modality === k);
    m.classList.toggle("is-low", val > 0 && val < threshold);
  });

  // expose winner for the Execute button
  state.pending = winner
    ? {
        modality: winner.modality,
        command: winner.cmd,
        confidence: Math.round(winner.conf),
        fallback: autoFallback,
        conflict: conflictLogged,
      }
    : null;

  // enable/disable Execute button to reflect readiness
  const execBtn = $('[data-action="execute"]');
  if (execBtn) execBtn.disabled = !winner;
}

// ---- 6. Gesture: MediaPipe Hands ----------------------------
/* Gesture rules are simple landmark-distance heuristics.
 *   - landmarks: 21 hand landmarks per hand
 *   - fingers up: tip y above pip y (mirrored depending on handedness,
 *     but we use distance-from-wrist which is handedness-agnostic)
 * Confidence = (handedness score) × (rule match strength), 0..100.
 */

function fingerExtended(landmarks, tip, pip) {
  // "extended" if tip is farther from wrist than pip
  const wrist = landmarks[0];
  const tipD = Math.hypot(landmarks[tip].x - wrist.x, landmarks[tip].y - wrist.y);
  const pipD = Math.hypot(landmarks[pip].x - wrist.x, landmarks[pip].y - wrist.y);
  return tipD > pipD * 1.08;
}

function classifyGesture(landmarks) {
  // fingers: [thumb, index, middle, ring, pinky]
  const idxTip = 8, idxPip = 6;
  const midTip = 12, midPip = 10;
  const ringTip = 16, ringPip = 14;
  const pinkyTip = 20, pinkyPip = 18;
  const thumbTip = 4, thumbIp = 3;

  const index = fingerExtended(landmarks, idxTip, idxPip);
  const middle = fingerExtended(landmarks, midTip, midPip);
  const ring = fingerExtended(landmarks, ringTip, ringPip);
  const pinky = fingerExtended(landmarks, pinkyTip, pinkyPip);
  // thumb: compare x distance from index base (lateral)
  const thumb = Math.abs(landmarks[thumbTip].x - landmarks[5].x) >
                Math.abs(landmarks[thumbIp].x - landmarks[5].x) * 1.1;

  const up = [thumb, index, middle, ring, pinky];
  const count = up.filter(Boolean).length;

  // open palm: 4+ fingers + thumb
  if (count >= 5) return { cmd: "wake", strength: 0.95 };
  // fist: 0 fingers
  if (count === 0) return { cmd: "mute", strength: 0.92 };
  // peace: index + middle only
  if (index && middle && !ring && !pinky) return { cmd: "pause", strength: 0.9 };
  // pointing: index only
  if (index && !middle && !ring && !pinky) return { cmd: "unmute", strength: 0.88 };
  // thumbs up: thumb only (and index down)
  if (thumb && !index && !middle && !ring && !pinky) return { cmd: "volume up", strength: 0.85 };
  return null;
}

function drawHandLandmarks(ctx, landmarks, w, h) {
  ctx.strokeStyle = "#17a090";
  ctx.lineWidth = 3;
  const conn = [
    [0,1],[1,2],[2,3],[3,4],            // thumb
    [0,5],[5,6],[6,7],[7,8],            // index
    [5,9],[9,10],[10,11],[11,12],       // middle
    [9,13],[13,14],[14,15],[15,16],     // ring
    [13,17],[17,18],[18,19],[19,20],    // pinky
    [0,17],                            // palm
  ];
  for (const [a,b] of conn) {
    ctx.beginPath();
    ctx.moveTo(landmarks[a].x * w, landmarks[a].y * h);
    ctx.lineTo(landmarks[b].x * w, landmarks[b].y * h);
    ctx.stroke();
  }
  ctx.fillStyle = "#e8812e";
  for (const p of landmarks) {
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

async function initHands() {
  if (typeof Hands === "undefined") return null;
  const hands = new Hands({
    locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`,
  });
  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 0,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.5,
  });
  hands.onResults(onHandResults);
  return hands;
}

function onHandResults(results) {
  const canvas = $("#camera-canvas");
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (results.multiHandLandmarks && results.multiHandLandmarks.length) {
    const lm = results.multiHandLandmarks[0];
    drawHandLandmarks(ctx, lm, w, h);
    const g = classifyGesture(lm);
    // handedness score 0..1
    const hs = results.multiHandedness?.[0]?.score ?? 0.9;
    if (g) {
      const conf = clamp(Math.round(hs * g.strength * 100));
      setModality("gesture", conf, g.cmd);
      return;
    }
  }
  // decay if no hand
  setModality("gesture", Math.max(0, state.confidences.gesture - 8), state.commands.gesture);
}

// ---- 8. Eye-tracking: Face Mesh + iris -----------------------
/* Face Mesh with refineLandmarks gives 478 landmarks including iris.
 * We use landmarks 468 (left iris center) and 473 (right iris center),
 * plus eye corners (33, 133, 362, 263) to compute a normalized iris
 * offset. Calibration maps 5 iris offsets to known screen points,
 * then we bilinearly interpolate.
 */
async function initFaceMesh() {
  if (typeof FaceMesh === "undefined") return null;
  const fm = new FaceMesh({
    locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`,
  });
  fm.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  fm.onResults(onFaceResults);
  return fm;
}

function irisOffset(landmarks) {
  // average iris center
  const lx = (landmarks[468].x + landmarks[473].x) / 2;
  const ly = (landmarks[468].y + landmarks[473].y) / 2;
  // left eye corners
  const lCorner = landmarks[33];
  const rCorner = landmarks[133];
  const eyeCx = (lCorner.x + rCorner.x) / 2;
  const eyeCy = (lCorner.y + rCorner.y) / 2;
  const eyeW = Math.abs(rCorner.x - lCorner.x) || 0.001;
  // right eye corners for vertical
  const tCorner = landmarks[159];
  const bCorner = landmarks[145];
  const eyeH = Math.abs(bCorner.y - tCorner.y) || 0.001;
  return {
    x: (lx - eyeCx) / eyeW,   // ~ -0.5 .. 0.5
    y: (ly - eyeCy) / eyeH,
  };
}

function onFaceResults(results) {
  const canvas = $("#camera-canvas");
  const ctx = canvas.getContext("2d");
  if (results.multiFaceLandmarks && results.multiFaceLandmarks.length) {
    const lm = results.multiFaceLandmarks[0];
    drawFaceGaze(ctx, lm, canvas.width, canvas.height);
    const off = irisOffset(lm);
    updateGazeFromIris(off);
    // eye confidence: presence + tracking
    setModality("eye", clamp(80), state.commands.eye ?? "unmute");
  } else {
    setModality("eye", Math.max(0, state.confidences.eye - 6), state.commands.eye);
  }
}

function drawFaceGaze(ctx, lm, w, h) {
  // draw a small ring around each iris center
  ctx.strokeStyle = "#e8812e";
  ctx.lineWidth = 2;
  for (const idx of [468, 473]) {
    const p = lm[idx];
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, 8, 0, Math.PI * 2);
    ctx.stroke();
  }
  // eye contour outline (left)
  ctx.strokeStyle = "rgba(232,129,46,0.5)";
  ctx.beginPath();
  for (const idx of [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246, 33]) {
    ctx.lineTo(lm[idx].x * w, lm[idx].y * h);
  }
  ctx.stroke();
}

// calibration mapping
function updateGazeFromIris(off) {
  if (state.calibration.length < 5) return; // need calibration
  // bilinear-ish mapping using 5 calibrated points:
  // index: 0 center, 1 TL, 2 TR, 3 BL, 4 BR
  const c = state.calibration;
  const sx = off.x, sy = off.y;
  // weighted average by inverse distance to each calibrated iris
  let wx = 0, wy = 0, wsum = 0;
  for (const p of c) {
    const d = Math.hypot(p.iris.x - sx, p.iris.y - sy) + 0.001;
    const wgt = 1 / (d * d);
    wx += p.screen.x * wgt;
    wy += p.screen.y * wgt;
    wsum += wgt;
  }
  const gx = wx / wsum;
  const gy = wy / wsum;
  state.gaze.x = clamp(gx, 0, window.innerWidth);
  state.gaze.y = clamp(gy, 0, window.innerHeight);
  state.gaze.active = true;
  moveGazeCursor();
  evaluateDwell();
}

let gazeCursor = null;
function ensureGazeCursor() {
  if (!gazeCursor) {
    gazeCursor = document.createElement("div");
    gazeCursor.className = "gaze-cursor";
    gazeCursor.setAttribute("aria-hidden", "true");
    gazeCursor.innerHTML = '<div class="gaze-cursor__ring"></div>';
    document.body.appendChild(gazeCursor);
  }
  return gazeCursor;
}
function moveGazeCursor() {
  if (!state.gaze.active) return;
  const c = ensureGazeCursor();
  c.style.left = state.gaze.x + "px";
  c.style.top = state.gaze.y + "px";
}

function evaluateDwell() {
  if (!state.gaze.active) return;
  const el = document.elementFromPoint(state.gaze.x, state.gaze.y);
  const target = el?.closest(".gaze-target");
  if (target !== state.dwell.target) {
    // reset
    if (state.dwell.timer) { clearTimeout(state.dwell.timer); state.dwell.timer = null; }
    state.dwell.target?.classList.remove("is-dwelling");
    state.dwell.target = target || null;
    if (target) {
      target.classList.add("is-dwelling");
      state.dwell.started = nowMs();
      state.dwell.timer = setTimeout(() => {
        logEvent({ modality: "eye", command: "dwell select", confidence: state.confidences.eye, result: "ok", note: "2s dwell" });
        target.click();
        target.classList.remove("is-dwelling");
        state.dwell.target = null;
        state.dwell.timer = null;
      }, ENGINE.dwellMs);
    }
  }
}

// ---- 7. Voice: Web Speech API -------------------------------
function initSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.lang = "en-IN";
  r.continuous = false;
  r.interimResults = true;
  r.maxAlternatives = 3;

  let finalTranscript = "";

  r.onstart = () => {
    setMicButton(true);
    announce("Listening.");
  };
  r.onresult = (ev) => {
    finalTranscript = "";
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i];
      if (res.isFinal) finalTranscript += res[0].transcript;
      else interim += res[0].transcript;
    }
    const text = (finalTranscript || interim).toLowerCase().trim();
    const match = matchVoiceCommand(text);
    if (match) {
      const conf = clamp(Math.round((ev.results[ev.results.length - 1][0].confidence || 0.7) * 100));
      setModality("voice", conf, match);
    }
  };
  r.onerror = (e) => {
    setMicButton(false);
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      setStatus("voice", "denied");
      logEvent({ modality: "voice", command: "—", confidence: 0, result: "fail", note: "mic denied" });
    } else {
      logEvent({ modality: "voice", command: "—", confidence: 0, result: "fail", note: e.error });
    }
  };
  r.onend = () => setMicButton(false);
  return r;
}

function matchVoiceCommand(text) {
  const map = [
    ["open browser", "open browser"],
    ["volume up", "volume up"],
    ["volume down", "volume down"],
    ["unmute", "unmute"],
    ["mute", "mute"],
    ["pause", "pause"],
    ["play", "play"],
  ];
  for (const [phrase, cmd] of map) {
    if (text.includes(phrase)) return cmd;
  }
  return null;
}

function setMicButton(on) {
  const b = $("#mic-btn");
  if (!b) return;
  b.setAttribute("aria-pressed", String(on));
  b.textContent = on ? "🎤 Listening…" : "🎤 Listen once";
}

// ---- set modality helper (drives the engine) ----------------
function setModality(modality, conf, cmd) {
  state.confidences[modality] = clamp(conf);
  if (cmd !== undefined) state.commands[modality] = cmd;
  updateMeters();
  computeEngine();
}

function updateMeters() {
  for (const m of $$(".meter")) {
    const k = m.dataset.meter;
    const val = Math.round(state.confidences[k]);
    const v = m.querySelector("[data-meter-value]");
    const f = m.querySelector("[data-meter-fill]");
    if (v) v.textContent = val + "%";
    if (f) f.style.width = val + "%";
  }
}

// ---- camera + live loop -------------------------------------
async function startCamera() {
  if (state.stream) return state.stream;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: 640, height: 480 },
      audio: false,
    });
    state.stream = stream;
    const video = $("#camera-video");
    video.srcObject = stream;
    await video.play();
    // size canvas to video
    const canvas = $("#camera-canvas");
    canvas.width = 640;
    canvas.height = 480;
    return stream;
  } catch (e) {
    state.stream = null;
    throw e;
  }
}

async function startLiveLoop() {
  const overlay = $("#camera-overlay");
  // real or simulate?
  if (state.simulate) {
    overlay.hidden = false;
    $("#camera-overlay-text").textContent = "Simulate mode is on. Use the Simulate panel to drive inputs.";
    $("#simulate-enable").hidden = true;
    return;
  }
  // try camera
  try {
    await startCamera();
    overlay.hidden = true;
    setStatus("gesture", "granted");
    setStatus("eye", "granted");
  } catch (e) {
    overlay.hidden = false;
    $("#camera-overlay-text").textContent = "Camera unavailable or denied. You can still run the demo in Simulate mode.";
    $("#simulate-enable").hidden = false;
    setStatus("gesture", "denied");
    setStatus("eye", "denied");
    return;
  }

  // init MediaPipe if needed
  if (!state.hands) state.hands = await initHands();
  if (!state.faceMesh) state.faceMesh = await initFaceMesh();

  const video = $("#camera-video");
  // pump frames to both solutions via rAF
  const pump = async () => {
    if (state.screen !== 3) return;
    if (state.hands && video.readyState >= 2) {
      try { await state.hands.send({ image: video }); } catch {}
    }
    if (state.faceMesh && video.readyState >= 2) {
      try { await state.faceMesh.send({ image: video }); } catch {}
    }
    state.rafId = requestAnimationFrame(pump);
  };
  pump();
  announce("Live assistant started.");
}

function stopLiveLoop() {
  if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
}

// status dots
function setStatus(modality, status) {
  state.permissions[modality] = status;
  const card = document.querySelector(`.tcard[data-modality="${modality}"]`);
  if (!card) return;
  const dot = card.querySelector("[data-status-dot]");
  const txt = card.querySelector("[data-status-text]");
  dot.classList.remove("is-on", "is-err", "is-warn");
  if (status === "granted") dot.classList.add("is-on");
  else if (status === "denied") dot.classList.add("is-err");
  else if (status === "sim") dot.classList.add("is-warn");
  const label = {
    idle: "Not requested",
    granted: "Granted",
    denied: "Denied — Simulate available",
    sim: "Simulate mode",
  }[status];
  txt.textContent = label;

  // camera pill on live screen
  const camStatus = document.querySelector("[data-cam-status]");
  if (camStatus) {
    const anyCam = state.permissions.gesture === "granted" || state.permissions.eye === "granted";
    camStatus.textContent = `Camera: ${anyCam ? "live" : state.permissions.gesture === "sim" ? "simulate" : "idle"}`;
  }
}

// ---- 9. Demo media player -----------------------------------
const player = { playing: true, muted: false, volume: 70, progress: 35, timer: null };

function startPlayerTicker() {
  if (player.timer) return;
  player.timer = setInterval(() => {
    if (player.playing && !player.muted) {
      player.progress = (player.progress + 0.4) % 100;
      $("#player-bar").style.width = player.progress + "%";
    }
  }, 200);
}
startPlayerTicker();

function applyCommand(cmd) {
  const startedAt = nowMs();
  let ok = true;
  switch (cmd) {
    case "play":
      player.playing = true;
      $("#player-state").textContent = "playing";
      $("#player-play").textContent = "⏸";
      break;
    case "pause":
      player.playing = false;
      $("#player-state").textContent = "paused";
      $("#player-play").textContent = "▶";
      break;
    case "mute":
      player.muted = true;
      $("#player-mute").textContent = "🔇";
      break;
    case "unmute":
      player.muted = false;
      $("#player-mute").textContent = "🔊";
      break;
    case "volume up":
      player.volume = clamp(player.volume + 10, 0, 100);
      break;
    case "volume down":
      player.volume = clamp(player.volume - 10, 0, 100);
      break;
    case "wake":
      // wake: flash a subtle highlight on the player
      break;
    case "open browser": {
      const card = $("#browser-card");
      card.hidden = false;
      setTimeout(() => { card.hidden = true; }, 4000);
      break;
    }
    default:
      ok = false;
  }
  // update player UI
  $("#player-vol").style.width = player.volume + "%";
  $("#player-vol-num").textContent = player.volume;
  const responseMs = Math.round(nowMs() - startedAt);
  return { ok, responseMs };
}

// ---- 10. Simulate mode --------------------------------------
function enableSimulate() {
  state.simulate = true;
  setStatus("gesture", "sim");
  setStatus("voice", "sim");
  setStatus("eye", "sim");
  document.querySelector("[data-sim-status]").textContent = "Simulate: on";
  const overlay = $("#camera-overlay");
  overlay.hidden = false;
  $("#camera-overlay-text").textContent = "Simulate mode is on. Use the Simulate panel to drive inputs.";
  $("#simulate-enable").hidden = true;
  // give eye a baseline so dwell works in confirm screen
  setModality("eye", 70, "unmute");
  announce("Simulate mode on.");
  logEvent({ modality: "—", command: "—", confidence: 0, result: "ok", note: "simulate on" });
}

// ---- 11. Wire-up per screen ---------------------------------

// Screen 1: persona
$$('input[name="persona"]').forEach((r) =>
  r.addEventListener("change", () => { state.persona = r.value; })
);

// Screen 2: permission buttons
$$("[data-permission]").forEach((btn) =>
  btn.addEventListener("click", async () => {
    const m = btn.dataset.permission;
    if (m === "voice") {
      try {
        if (!state.recognition) state.recognition = initSpeech();
        if (!state.recognition) {
          setStatus("voice", "denied");
          return;
        }
        // request mic briefly to get permission
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
        setStatus("voice", "granted");
      } catch {
        setStatus("voice", "denied");
      }
      return;
    }
    // gesture + eye both need camera
    try {
      await startCamera();
      setStatus("gesture", "granted");
      setStatus("eye", "granted");
    } catch {
      setStatus("gesture", "denied");
      setStatus("eye", "denied");
    }
  })
);

// threshold slider
const thrSlider = $("#threshold-slider");
const thrValue = $("#threshold-value");
thrSlider.addEventListener("input", () => {
  state.threshold = Number(thrSlider.value);
  thrValue.textContent = state.threshold + "%";
  computeEngine();
});

// calibration
let calPoints = 0;
$("#calibrate-start").addEventListener("click", async () => {
  // ensure camera + face mesh running
  try {
    await startCamera();
    if (!state.faceMesh) state.faceMesh = await initFaceMesh();
  } catch {
    $("#camera-overlay-text").textContent = "Camera needed for calibration. Try Simulate mode.";
    return;
  }
  state.calibration = [];
  calPoints = 0;
  $("#calibration-stage").hidden = false;
  $("#cal-progress").textContent = "0";
  $$(".cal-dot").forEach((d) => d.classList.remove("is-done"));
  // pump a single frame to capture iris on click
  announce("Calibration started. Look at each dot and click it.");
});

// We need to capture the iris offset at the moment a calibration dot is clicked.
let lastIrisOffset = null;
const fmPump = async () => {
  if (state.faceMesh && state.stream) {
    const v = $("#camera-video");
    if (v.readyState >= 2) {
      try {
        await state.faceMesh.send({ image: v });
      } catch {}
    }
  }
};
// override onFaceResults to also stash the latest iris offset
const _origFace = onFaceResults;
window.__faceHook = (lm) => { lastIrisOffset = irisOffset(lm); };

// patch onFaceResults to expose iris
function onFaceResultsPatched(results) {
  const canvas = $("#camera-canvas");
  const ctx = canvas.getContext("2d");
  if (results.multiFaceLandmarks && results.multiFaceLandmarks.length) {
    const lm = results.multiFaceLandmarks[0];
    drawFaceGaze(ctx, lm, canvas.width, canvas.height);
    lastIrisOffset = irisOffset(lm);
    updateGazeFromIris(lastIrisOffset);
    setModality("eye", clamp(80), state.commands.eye ?? "unmute");
  } else {
    setModality("eye", Math.max(0, state.confidences.eye - 6), state.commands.eye);
  }
}
// replace the reference used by FaceMesh: easiest is to re-init when calibrating
// but to keep things simple we re-bind onResults here.
async function rebindFaceMesh() {
  if (!state.faceMesh) state.faceMesh = await initFaceMesh();
  state.faceMesh.onResults(onFaceResultsPatched);
}

$$(".cal-dot").forEach((dot) =>
  dot.addEventListener("click", async () => {
    if (!state.faceMesh) await rebindFaceMesh();
    // capture a frame now to get fresh iris
    const v = $("#camera-video");
    if (v.readyState >= 2) { try { await state.faceMesh.send({ image: v }); } catch {} }
    if (!lastIrisOffset) return;
    const screenPoints = [
      { x: window.innerWidth / 2, y: window.innerHeight / 2 },       // center
      { x: window.innerWidth * 0.18, y: window.innerHeight * 0.18 },  // TL
      { x: window.innerWidth * 0.82, y: window.innerHeight * 0.18 },  // TR
      { x: window.innerWidth * 0.18, y: window.innerHeight * 0.82 },  // BL
      { x: window.innerWidth * 0.82, y: window.innerHeight * 0.82 },  // BR
    ];
    const idx = Number(dot.dataset.pt);
    state.calibration.push({ iris: lastIrisOffset, screen: screenPoints[idx] });
    dot.classList.add("is-done");
    calPoints++;
    $("#cal-progress").textContent = String(calPoints);
    logEvent({ modality: "eye", command: "calibrate", confidence: 100, result: "ok", note: `point ${idx + 1}/5` });
    if (calPoints >= 5) {
      announce("Calibration complete.");
      // switch back to live hook
      if (state.faceMesh) state.faceMesh.onResults(onFaceResultsPatched);
    }
  })
);

// Screen 3 controls
$("#mic-btn").addEventListener("click", () => {
  if (!state.recognition) state.recognition = initSpeech();
  if (!state.recognition) {
    // simulate a voice command if SR unavailable
    setModality("voice", 0, null);
    setStatus("voice", "denied");
    return;
  }
  try { state.recognition.start(); } catch { /* already running */ }
});

$("#noise-btn").addEventListener("click", () => {
  state.noisy = !state.noisy;
  $("#noise-btn").textContent = state.noisy ? "Noisy environment: ON" : "Simulate noisy environment";
  if (state.noisy) {
    setModality("gesture", clamp(state.confidences.gesture), state.commands.gesture);
    setModality("voice", clamp(state.confidences.voice), state.commands.voice);
    logEvent({ modality: "—", command: "—", confidence: 0, result: "ok", note: "noisy on" });
  }
  computeEngine();
});

$("#sim-panel-btn").addEventListener("click", () => {
  const p = $("#sim-panel");
  const open = p.hidden;
  p.hidden = !open;
  $("#sim-panel-btn").setAttribute("aria-expanded", String(open));
});

$$("[data-sim]").forEach((b) =>
  b.addEventListener("click", () => {
    const payload = JSON.parse(b.dataset.sim);
    setModality(payload.modality, payload.confidence, payload.command);
    logEvent({ modality: payload.modality, command: payload.command, confidence: payload.confidence, result: "ok", note: "simulated" });
  })
);

$("#simulate-enable").addEventListener("click", enableSimulate);

// Execute -> screen 4
$('[data-action="execute"]').addEventListener("click", () => {
  if (!state.pending) return;
  goScreen(4);
});

// Screen 4 setup
function setupConfirmScreen() {
  const p = state.pending;
  const banner = $("#confirm-banner");
  banner.classList.remove("banner--info", "banner--warn");
  if (!p) {
    banner.classList.add("banner--warn");
    banner.innerHTML = '<span class="banner__icon">⚠</span> No command detected yet. Go back and try an input.';
    $("#cf-modality").textContent = "—";
    $("#cf-command").textContent = "—";
    $("#cf-confidence").textContent = "—";
    $("#cf-fallback").textContent = "—";
    $("#confirm-yes").disabled = true;
    return;
  }
  $("#confirm-yes").disabled = false;
  $("#cf-modality").textContent = p.modality;
  $("#cf-command").textContent = COMMANDS[p.command]?.label ?? p.command;
  $("#cf-confidence").textContent = p.confidence + "%";
  $("#cf-fallback").textContent = p.fallback ? "Yes" : "No";

  if (p.fallback) {
    banner.classList.add("banner--warn");
    banner.innerHTML = `<span class="banner__icon">⚠</span> Gesture and voice both < 60%. Auto-switching to Eye-Tracking at ${p.confidence}%.`;
  } else if (p.confidence >= state.threshold) {
    banner.classList.add("banner--info");
    banner.innerHTML = `<span class="banner__icon">✓</span> ${p.modality} ${p.confidence}% ≥ ${state.threshold}% threshold — executing via ${p.modality}.`;
  } else {
    banner.classList.add("banner--warn");
    banner.innerHTML = `<span class="banner__icon">⚠</span> ${p.modality} ${p.confidence}% < ${state.threshold}%. Below threshold — needs a higher-confidence input.`;
  }
}

$("#confirm-yes").addEventListener("click", () => {
  const p = state.pending;
  if (!p) return;
  const t0 = nowMs();
  const res = applyCommand(p.command);
  const responseMs = Math.max(res.responseMs, Math.round(nowMs() - t0));
  const entry = {
    modality: p.modality,
    command: p.command,
    confidence: p.confidence,
    result: "ok",
    fallback: p.fallback,
    note: p.conflict ? "conflict resolved" : "",
  };
  logEvent(entry);
  state.lastExecuted = { ...p, responseMs };
  goScreen(5);
});
$("#confirm-no").addEventListener("click", () => {
  logEvent({ modality: state.pending?.modality ?? "—", command: state.pending?.command ?? "—", confidence: state.pending?.confidence ?? 0, result: "fail", note: "cancelled" });
  goScreen(3);
});

// Screen 5 render
function renderSuccess() {
  const e = state.lastExecuted;
  if (!e) return;
  $("#s-modality").textContent = e.modality;
  $("#s-confidence").textContent = e.confidence + "%";
  $("#s-response").textContent = e.responseMs + " ms";
  $("#s-fallback").textContent = e.fallback ? "Yes" : "No";
  $("#s-command").textContent = COMMANDS[e.command]?.label ?? e.command;
  renderLog();
}

// intercept screen 5 navigation to render
const _origGo = goScreen;
// (we already call renderLog inside logEvent; render on show)
const obs = new MutationObserver(() => {
  if (!$("#screen-success").hidden) renderSuccess();
});
obs.observe($("#screen-success"), { attributes: true, attributeFilter: ["hidden"] });

// ---- Boot ---------------------------------------------------
buildIndicator();
// persona default already 'aurora'
// make sure player UI matches initial state
$("#player-vol").style.width = player.volume + "%";
$("#player-vol-num").textContent = player.volume;
updateMeters();
announce("STORI ready. Step 1 of 5.");
