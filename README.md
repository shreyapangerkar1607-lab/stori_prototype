# STORI — Multimodal AI Assistant for Disabled Users

**Gesture, Voice and Eye-Tracking with intelligent fallbacks.**

Don Bosco Institute of Technology · Dept. of Computer Engineering · Track 2, Group 5
Experiment 5 — working prototype with a 5-screen forward user flow.

---

## What it does

STORI lets a user control a demo media player using **three input modalities**:

1. **Gesture** — webcam + MediaPipe Hands recognises 5 hand signs:
   open palm = Wake, closed fist = Mute, thumbs up = Volume Up, peace = Pause/Play, pointing = Unmute.
2. **Voice** — Web Speech API (`en-IN`) recognises spoken commands:
   "mute", "unmute", "volume up", "volume down", "pause", "play", "open browser".
3. **Eye-Tracking** — MediaPipe Face Mesh (`refineLandmarks`) extracts iris landmarks,
   a 5-point calibration maps iris position to screen coordinates, and a visible gaze
   cursor dwells on a button for 2 seconds to select it.

A **confidence engine** (the core of the project) scores each modality live, picks the
highest-confidence input, and — when gesture and voice both fall below 60% — auto-falls
back to eye-tracking. Every event is logged in memory and shown on the final screen.

**Privacy:** all processing is on-device in the browser. No video, audio or biometric
data is ever uploaded.

## Tech stack

- Plain HTML5 + CSS3 + vanilla JavaScript (ES module). No build step.
- CDN libraries: MediaPipe `hands`, `face_mesh`, `camera_utils`; Web Speech API (built into the browser); Google Fonts (Inter).
- Responsive — works on phone (primary) and desktop.

> **HTTPS is required.** The browser only grants camera/microphone on `https://` or `http://localhost`. If you open `index.html` directly from disk (`file://…`) the permissions will be blocked and STORI will fall back to **Simulate mode** (on-screen buttons that fake each modality's confidence).

## Run locally

Pick one:

**Option A — VS Code Live Server (recommended)**
1. Install the "Live Server" extension.
2. Right-click `index.html` → **Open with Live Server**.
3. A browser tab opens at `http://127.0.0.1:5500`. Allow camera + mic when prompted.

**Option B — Python**
```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Either way, open the URL in **Chrome or Edge** (Web Speech API + MediaPipe support is best there), and click **Get Started**.

### Simulate mode (no permissions)

If you deny camera/mic — or your environment blocks them — STORI shows a friendly
overlay with an **Enable Simulate mode** button. Simulate mode exposes on-screen
buttons that fake each modality's confidence and command, so the demo never breaks.
There's also a **Simulate noisy environment** button that drops gesture and voice below
60% to trigger the auto-fallback to eye-tracking.

## Deploy to GitHub Pages

1. Create a new repository and push the three files (`index.html`, `style.css`, `script.js`) plus this README to the `main` branch.
2. In the repo: **Settings → Pages → Source: Deploy from a branch → `main` / root**.
3. Wait ~1 minute. Your site is live at `https://<your-username>.github.io/<repo-name>/`.
4. GitHub Pages serves over HTTPS, so camera/mic will work without any extra setup.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The 5-screen SPA markup + CDN script tags |
| `style.css` | Full design system, accessibility, responsive, high-contrast, reduced-motion |
| `script.js` | Confidence engine, MediaPipe + Web Speech wiring, gaze/dwell, simulate, logging |
| `README.md` | This file |

## Accessibility

- WCAG 2.1 AA targets (≥48px), visible focus outlines, `aria-label`/`aria-live`, full keyboard nav.
- **High-contrast toggle** in the header.
- Honors `prefers-reduced-motion` and exposes a `.reduce-motion` class.

## Footer

> Don Bosco Institute of Technology | Dept. of Computer Engineering | Track 2, Group 5

---

## Lab-report blocks (one per screen)

Paste these straight into your Experiment 5 report.

### Screen 1 — Landing

- **Purpose:** Introduce STORI, state the on-device privacy guarantee, and let the user pick a persona that tunes which modalities take priority.
- **What the user sees and does:** The STORI logo and tagline ("Control your device your way. If one method fails, we switch for you."), three modality chips (hand, mic, eye), a privacy note, and two persona cards (Aurora — blind law student, voice-first; Ares — hand-mobility professional, eye+voice-first). The user selects a persona and reads the privacy note.
- **Forward trigger (button → next screen):** "Get Started" → Screen 2 (Setup).

### Screen 2 — Setup

- **Purpose:** Request permissions for each modality, set the confidence threshold, and calibrate eye-tracking.
- **What the user sees and does:** Three toggle cards (Gesture, Voice, Eye-Tracking) each with a permission button and a status dot; a fallback-hierarchy diagram (Gesture → Voice → Eye-Tracking); a threshold slider (default 75%); and a 5-point calibration routine (click the five dots while looking at them). The user grants permissions, adjusts the threshold, and completes calibration.
- **Forward trigger (button → next screen):** "Start Assistant" → Screen 3 (Live Assistant).

### Screen 3 — Live Assistant

- **Purpose:** The main feature — detect, score, and act on gesture, voice and eye inputs in real time.
- **What the user sees and does:** A live camera preview with hand and iris landmarks drawn on a canvas; three animated confidence meters; a "Detected command" box; a demo media player (play/pause, mute, volume bar, "browser opened" card); a command cheat-sheet; a "Listen once" mic button; and a "Simulate noisy environment" button. As the user gestures, speaks or looks, the meters fill and the detected command updates.
- **Forward trigger (button → next screen):** "Execute Command" → Screen 4 (Confirmation/Fallback Review).

### Screen 4 — Confirmation / Fallback Review

- **Purpose:** Show the engine's decision before acting, and let the user confirm or cancel — large, gaze-selectable buttons support dwell selection.
- **What the user sees and does:** A banner stating the decision (e.g. "Gesture 82% ≥ 75%, executing via Gesture" or "Gesture 48% and Voice 52% both < 60%, auto-switching to Eye-Tracking"); a small flow diagram Input → Confidence Score → Threshold → Execute/Fallback; a summary (modality, command, confidence, fallback triggered); and two large Confirm / Cancel buttons. In eye-tracking mode the user dwells on a button for 2 seconds to select it.
- **Forward triggers (button → next screen):** "Confirm" → Screen 5 (Success/Status). "Cancel" → Screen 3 (Live Assistant).

### Screen 5 — Success / Status

- **Purpose:** Confirm execution and present a summary plus the last 5 logged events.
- **What the user sees and does:** An animated check, "Command executed successfully", a summary card (modality used, confidence %, response time in ms, fallback triggered yes/no, command), and a list of the last 5 log entries (time, modality, command, confidence, result/fallback tag).
- **Forward triggers (button → next screen):** "Run Another Command" → Screen 3 (Live Assistant). "Back to Home" → Screen 1 (Landing).

---

## Confidence engine — short write-up (for the report)

Each modality produces a live confidence score 0–100%:

- **Gesture:** `handednessScore × ruleMatchStrength × 100`, where `ruleMatchStrength` is a fixed per-gesture quality (e.g. 0.95 for a clean open palm).
- **Voice:** `recognition.confidence × 100` from the Web Speech API final result.
- **Eye:** a fixed tracking confidence (calibration-dependent) while a face is detected.

Decision rules, recomputed on every input change:

1. The modality with the highest confidence that also has a command becomes the candidate.
2. If the candidate's confidence ≥ the user threshold (default 75%), it is marked ready to execute.
3. If **both** gesture and voice are below 60%, the engine auto-switches to eye-tracking and shows a banner.
4. If two inputs arrive within 5% of each other, the higher-priority modality in the hierarchy `[Gesture, Voice, Eye]` wins and a conflict is logged.

Every event — time, modality, command, confidence, success/fail, fallback triggered — is appended to an in-memory log shown on Screen 5.
