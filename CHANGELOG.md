# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-24

### Added

- Turns off Discord's noise suppression (Krisp or Standard) while Soundpad is playing and restores the previous mode afterwards.
- Launches Discord with `--remote-debugging-pipe`; no network port is opened. An already running Discord is restarted automatically.
- Single-instance lock, so a second launch does not restart Discord again.
- The previous noise-suppression mode is saved to disk and restored if Discord is closed mid-sound.
- 3-second settle delay after attaching, because Discord briefly reports "Standard" while Krisp initializes.
- `config.json` with `pollMs` and `releaseDelayMs`; UTF-8 with BOM is accepted.
- Windowless single-file `SoundpadKrisp.exe` built with Node.js SEA, with a SHA-256 checksum.

[1.0.0]: https://github.com/birdesque/discord-soundpad-krisp/releases/tag/v1.0.0
