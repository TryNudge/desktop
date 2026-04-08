<p align="center">
  <img src="https://i.imgur.com/2RgIkQu.png" width="90" alt="Logo">
</p>

<h1 align="center">Nudge
  <p align="center">
    <a href="https://github.com/TryNudge/desktop/actions/workflows/release.yml">
      <img src="https://github.com/TryNudge/desktop/actions/workflows/release.yml/badge.svg" alt="Release">
    </a>
  </p>
</h1>

<p align="center">
  Nudge sees your screen, understands the context,<br>
  and walks you through it step-by-step.
</p>

---

## How It Works

Nudge captures your screen, sends it to a vision language model, and returns step-by-step instructions with precise click targets overlaid directly on your desktop.

1. **Screen Capture** — Takes a screenshot of your active window using [`mss`](https://github.com/BoboTiG/python-mss) and extracts the UI accessibility tree via [`pywinauto`](https://github.com/pywinauto/pywinauto). Multi-monitor aware with automatic downscaling for efficient AI processing.

2. **AI Context Recognition** — The screenshot, accessibility tree, and your query are sent to the backend VLM which analyses the visual context and generates a step-by-step plan with target coordinates.

3. **Local Grounding** — Coordinates are refined locally using a fallback chain: first the UI Automation tree (instant, highest accuracy), then OCR via [RapidOCR](https://github.com/RapidAI/RapidOCR) (fast text matching), and finally raw VLM coordinates as a last resort.

4. **Visual Overlay** — A transparent, click-through overlay renders animated cursor hints and natural language instructions directly on screen. Step through tasks one at a time or dismiss when done.

## Install

1. Download the latest `.exe` installer from [Releases](https://github.com/TryNudge/desktop/releases)
2. Run the installer — no admin required
3. Launch Nudge and sign in via the browser prompt
4. Press `Ctrl+Shift+N` to open the query bar and start asking


## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Framework | Tauri 2 (Rust) |
| Frontend | Vanilla HTML / CSS / JS |
| Screen Capture | Python (mss + Pillow + pywinauto) |
| Text Detection | RapidOCR (ONNX Runtime) |
| AI Inference | Nudge Backend processes data |

## Prerequisites to build

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 20+
- [Python](https://www.python.org/) 3.12+

## Setup

```bash
# Clone the repo
git clone https://github.com/TryNudge/desktop.git
cd desktop

# Install Python dependencies
python -m venv venv
venv/Scripts/activate  # Windows
pip install -r requirements.txt

# Install frontend dependencies
npm install
```

Create a `.env` file or set the environment variable:

```
NUDGE_PLATFORM_URL=https://platform.nudge.help
```

> In dev mode, the app spawns the Python sidecar directly from `./venv/Scripts/python.exe`. Make sure your venv is set up at the project root.

## Development

```bash
npm run tauri dev
```

This starts the Tauri dev server with hot-reload for the frontend and the Rust backend. The Python sidecar is spawned automatically from your local venv.

## Building

### Sidecar

The Python capture/grounding layer is compiled into a standalone executable using PyInstaller:

```bash
python build-sidecar.py
```

This outputs `src-tauri/binaries/sidecar-x86_64-pc-windows-msvc.exe`.

### App

```bash
npm run tauri build
```

Produces an NSIS installer, portable zip, and update signature in `src-tauri/target/release/bundle/`.

## Project Structure

```
NudgeDesktop/
├── src/                  # Frontend (HTML/CSS/JS windows)
│   ├── splash.*          # Onboarding + login
│   ├── input.*           # Query input bar
│   ├── overlay.*         # Visual step overlay
│   ├── control.*         # Step navigation
│   └── settings.*        # Configuration
├── src-tauri/            # Rust backend
│   ├── src/lib.rs        # Tauri commands, auth, sidecar orchestration
│   ├── tauri.conf.json   # App config + window definitions
│   └── binaries/         # Compiled sidecar exe
├── sidecar/server.py     # JSON-RPC bridge (stdin/stdout)
├── capture.py            # Screen capture, UIA tree, OCR, grounding
├── brain.py              # Step plan data structures
├── build-sidecar.py      # PyInstaller build script
└── requirements.txt      # Python dependencies
```

## License

Licensed under the [BSL 1.1](LICENSE.md). You can view, fork, and modify the code, but you may not use it to offer a competing commercial product or service.
