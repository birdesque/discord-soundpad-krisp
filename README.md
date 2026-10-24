# discord-soundpad-krisp

[![Build](https://github.com/birdesque/discord-soundpad-krisp/actions/workflows/build.yml/badge.svg)](https://github.com/birdesque/discord-soundpad-krisp/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/birdesque/discord-soundpad-krisp)](https://github.com/birdesque/discord-soundpad-krisp/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**English** · [Русский](README.ru.md)

A small Windows tool that turns off Discord's noise suppression (Krisp) while [Soundpad](https://www.leppsoft.com/soundpad/) is playing, then turns it back on.

## The problem

Soundpad plays sounds by mixing them into your microphone stream. Krisp treats music and sound effects as noise and filters them out, so other people hear your sounds muffled or not at all. Discord has no setting or hotkey to bypass Krisp for Soundpad, and its official RPC API only controls the "Standard" noise suppression, not Krisp.

## What it does

- Starts Discord for you. If Discord is already open, the tool restarts it.
- Watches Soundpad. While a sound is playing, noise suppression is turned off: Krisp or Standard, whichever you use.
- About 400 ms after the sound stops, it restores your previous mode.
- Leaves your settings alone if noise suppression was already off.
- Runs without a window. It exits when you quit Discord.

## Quick start

1. Download `SoundpadKrisp.exe` from the [latest release](https://github.com/birdesque/discord-soundpad-krisp/releases/latest).
2. Put it in any folder and run it. Discord will open (or restart) with the tool attached.
3. Recommended: in Soundpad, enable **File → Preferences → Audio → Block voice**. Your microphone is then muted while a sound plays, so people hear only the sound. This also means nothing is lost when Krisp is turned off during playback.

To start it with Windows, turn off "Open Discord" in Discord's Windows settings. Then put a shortcut to `SoundpadKrisp.exe` into the Startup folder (`Win+R` → `shell:startup`).

## How it works

```
Soundpad ──(named pipe: GetPlayStatus)──► SoundpadKrisp ──(DevTools pipe)──► Discord
```

- **Soundpad** is polled every 150 ms through its official [Remote Control interface](https://www.leppsoft.com/soundpad/rc), the named pipe `\\.\pipe\sp_remote_control`.
- **Discord** is launched with Chromium's `--remote-debugging-pipe` flag. The DevTools channel is a pair of inherited handles that only SoundpadKrisp holds. No network port is opened, and no other program can connect through it.
- Through that channel, the tool calls the same internal functions Discord's own noise-suppression toggle uses: `setNoiseCancellation` for Krisp and `setNoiseSuppression` for Standard. It finds them by the action name `AUDIO_SET_NOISE_CANCELLATION`, not by minified module IDs, so it survives most Discord updates.
- If Discord is closed in the middle of a sound, the previous mode is saved to `soundpad-krisp.state.json` and restored on the next start.

No Discord files are modified.

## Limitations

- **Discord's lifetime is tied to the tool.** Chromium quits when its DevTools pipe closes. Quitting Discord stops the tool, and killing the tool closes Discord.
- **Attaching to an already running Discord is not supported.** The tool restarts Discord instead, which drops an active voice call. Start it before joining a call.
- **Discord self-updates.** After Discord installs an update and restarts itself, it runs without the tool. Start `SoundpadKrisp.exe` again.
- **Push-to-talk.** With push-to-talk you still have to hold the key while a sound plays, otherwise Discord transmits nothing. Voice activity mode has no such issue.
- **Windows only.** Both Soundpad and the Discord install layout it relies on are Windows-specific.

## Configuration

Optional. Create `config.json` next to the exe (see [`config.example.json`](config.example.json)):

| Key | Default | Meaning |
|---|---|---|
| `pollMs` | `150` | How often to ask Soundpad whether it is playing, in ms |
| `releaseDelayMs` | `400` | How long to wait after a sound ends before restoring noise suppression |

## Troubleshooting

The log is written to `soundpad-krisp.log` next to the exe. The messages are in Russian:

| Log message | Meaning |
|---|---|
| `Discord ещё загружается` | Discord is still loading. The tool retries automatically. |
| `SoundPad не запущен — жду…` | Soundpad is not running. Start it; the tool picks it up automatically. |
| `Не нашёл модули шумодава — похоже, Discord обновился` | A Discord update changed its internals. Please [open an issue](https://github.com/birdesque/discord-soundpad-krisp/issues/new/choose). |
| `Не нашёл Discord в …` | Discord is not installed in the standard per-user location (`%LOCALAPPDATA%\Discord`). |

Windows SmartScreen or an antivirus may warn about the exe. It is `node.exe` with the script embedded, and embedding invalidates Node's original signature. Every release is built by GitHub Actions from this repository, and a `.sha256` file is attached so you can check the download.

## Building from source

Requires Windows and Node.js 22 or newer.

```bash
npm ci
npm run build
```

The exe is written to `dist/SoundpadKrisp.exe`. The build packs `src/soundpad-krisp.js` into a [Node.js single executable application](https://nodejs.org/api/single-executable-applications.html) with `postject`, and switches the PE subsystem to GUI so no console window appears.

You can also run it without building: `npm start`. The log then goes to the console as well.

Releases are produced by pushing a `vX.Y.Z` tag. The [workflow](.github/workflows/build.yml) builds the exe and attaches it to a GitHub release.

## Disclaimer

This is an unofficial tool. It is not affiliated with or endorsed by Discord Inc. or Leppsoft (Soundpad). Driving the Discord client through its DevTools interface is a client modification, in the same grey area as BetterDiscord or Vencord under Discord's Terms of Service. Use at your own risk.

## License

[MIT](LICENSE)
