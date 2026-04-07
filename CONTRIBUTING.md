# Contributing to Nudge

Thanks for your interest in contributing. Here's how to get started.

## Getting Started

1. Fork the repo and clone it locally
2. Follow the [setup instructions](README.md#setup) to get your dev environment running
3. Create a branch for your changes: `git checkout -b my-change`
4. Make your changes and test them locally with `cargo tauri dev`
5. Push and open a pull request

## What We're Looking For

- Bug fixes
- Performance improvements
- UI/UX refinements
- Better grounding accuracy (UIA, OCR)
- Documentation improvements

## Guidelines

- Keep PRs focused — one feature or fix per PR
- Test your changes on Windows before submitting
- Follow the existing code style — no need to over-document, just keep it readable
- Don't add dependencies without a good reason

## Architecture

- **Python** (`sidecar/`, `capture.py`, `brain.py`) — screen capture, UIA tree, OCR grounding
- **HTML/CSS/JS** (`src/`) — all UI windows (splash, input, overlay, control, settings)

The desktop app communicates with the Python sidecar over stdin/stdout JSON-RPC. AI inference happens on the backend, not locally.

## Reporting Issues

Open an issue on [GitHub](https://github.com/TryNudge/desktop/issues) with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your Windows version and Nudge version (from Settings)

## License

By contributing, you agree that your contributions will be licensed under the project's [BSL 1.1](LICENSE.md).
