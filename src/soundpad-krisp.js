#!/usr/bin/env node
// Launches Discord and turns off its noise suppression (Krisp or Standard) while Soundpad is playing.
//
// Discord is started with --remote-debugging-pipe: only this process holds the DevTools channel, no network port.
// The flip side: Chromium quits when the channel breaks, so Discord lives as long as this process does.
// When Discord is closed, this process exits too.
'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

let isSea = false;
try {
  isSea = require('node:sea').isSea();
} catch {}

// The build script replaces this with the version from package.json.
const VERSION = '__VERSION__';
const BASE_DIR = isSea ? path.dirname(process.execPath) : process.cwd();
const STATE_PATH = path.join(BASE_DIR, 'soundpad-krisp.state.json');
const LOG_PATH = path.join(BASE_DIR, 'soundpad-krisp.log');
const LOCK_PIPE = '\\\\.\\pipe\\soundpad-krisp-lock';
const DISCORD_URL = /^https:\/\/([a-z]+\.)?discord\.com\//;

function loadJson(file) {
  try {
    // Notepad saves UTF-8 with a BOM, which JSON.parse rejects.
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

const config = {
  pollMs: 150,
  releaseDelayMs: 400,
  ...loadJson(path.join(BASE_DIR, 'config.json')),
};

let logStream = null;
function log(...args) {
  const line = `${new Date().toTimeString().slice(0, 8)} ${args.join(' ')}`;
  logStream?.write(line + '\n');
  if (!isSea) console.log(line);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function openPipe(pipePath) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipePath);
    sock.once('connect', () => {
      sock.off('error', reject);
      resolve(sock);
    });
    sock.once('error', reject);
  });
}

// A second instance would kill the Discord started by the first one, so a named pipe serves as a lock.
function acquireLock() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error('Already running')));
    server.listen(LOCK_PIPE, () => resolve(server));
  });
}

// ---------- Soundpad ----------

class Soundpad {
  constructor() {
    this.sock = null;
    this.pending = null;
  }

  async connect() {
    const sock = await openPipe('\\\\.\\pipe\\sp_remote_control');
    sock.on('data', (data) => this._settle(null, data.toString('utf8')));
    sock.on('error', () => {});
    sock.on('close', () => {
      if (this.sock === sock) this.sock = null;
      this._settle(new Error('Soundpad closed the connection'));
    });
    this.sock = sock;
  }

  _settle(err, value) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    err ? pending.reject(err) : pending.resolve(value);
  }

  // One request at a time: the protocol is plain request/response without IDs.
  async request(command, timeoutMs = 1000) {
    if (!this.sock) await this.connect();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._settle(new Error('Soundpad did not respond'));
        this.sock?.destroy();
      }, timeoutMs);
      this.pending = { resolve, reject, timer };
      this.sock.write(command);
    });
  }

  // null means Soundpad is unavailable (not running).
  async isPlaying() {
    try {
      const status = (await this.request('GetPlayStatus()')).trim();
      return status === 'PLAYING' || status === 'SEEKING';
    } catch {
      return null;
    }
  }
}

// ---------- Discord (Chrome DevTools Protocol over a pipe) ----------

// Runs inside the Discord window. Finds the audio settings actions and store among the rspack modules.
// cmd: 'get' reads the state, 'off' turns everything off, { krisp, standard } restores a state.
function pageHelper(cmd) {
  if (!window.webpackChunkdiscord_app) throw new Error('Discord is still loading');
  if (!window.__soundpadNS) {
    const runtimes = [];
    window.webpackChunkdiscord_app.push([[Symbol()], {}, (r) => runtimes.push(r)]);
    window.webpackChunkdiscord_app.pop();

    const source = (fn) => {
      try {
        return Function.prototype.toString.call(fn);
      } catch {
        return '';
      }
    };
    let actions, store;
    for (const r of runtimes) {
      for (const id in r.c || {}) {
        try {
          const exp = r.c[id].exports;
          if (!exp) continue;
          for (const v of [exp, ...Object.values(exp)]) {
            if (!v || (typeof v !== 'object' && typeof v !== 'function')) continue;
            if (!actions && source(v.setNoiseCancellation).includes('AUDIO_SET_NOISE_CANCELLATION')) actions = v;
            if (!store && typeof v.getMediaEngine === 'function' && typeof v.getNoiseCancellation?.() === 'boolean') store = v;
          }
        } catch {}
      }
    }
    if (!actions || !store) throw new Error('Noise suppression modules not found, Discord may have been updated');
    window.__soundpadNS = { actions, store };
  }

  const { actions, store } = window.__soundpadNS;
  const target = cmd === 'off' ? { krisp: false, standard: false } : cmd;
  if (target && typeof target === 'object') {
    // setNoiseCancellation(x) also sets Standard to !x, so Standard is set afterwards.
    if (target.krisp) actions.setNoiseCancellation(true);
    else {
      if (store.getNoiseCancellation()) actions.setNoiseCancellation(false);
      actions.setNoiseSuppression(target.standard);
    }
  }
  return { krisp: store.getNoiseCancellation(), standard: store.getNoiseSuppression() };
}

function compareVersions(a, b) {
  const pa = a.split(/[-.]/).slice(1).map(Number);
  const pb = b.split(/[-.]/).slice(1).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function isDiscordRunning() {
  const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Discord.exe', '/NH'], { encoding: 'utf8' });
  return out.includes('Discord.exe');
}

class Discord {
  constructor() {
    this.proc = null;
    this.sessionId = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
  }

  async launch(onExit) {
    const root = path.join(process.env.LOCALAPPDATA, 'Discord');
    const app = fs
      .readdirSync(root)
      .filter((d) => /^app-[\d.]+$/.test(d))
      .sort(compareVersions)
      .pop();
    if (!app) throw new Error(`Discord not found in ${root}`);

    if (isDiscordRunning()) {
      log('Discord is already running, restarting it with the debugging pipe');
      try {
        execFileSync('taskkill', ['/IM', 'Discord.exe', '/F'], { stdio: 'ignore' });
      } catch {}
      for (let i = 0; i < 50 && isDiscordRunning(); i++) await sleep(200);
    }

    // Chromium reads commands from fd 3 and writes responses to fd 4.
    this.proc = spawn(path.join(root, app, 'Discord.exe'), ['--remote-debugging-pipe'], {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    });
    this.proc.stdio[3].on('error', () => {});
    this.proc.stdio[4].on('data', (data) => this._onData(data));
    this.proc.on('exit', () => {
      for (const { reject } of this.pending.values()) reject(new Error('Discord was closed'));
      this.pending.clear();
      onExit();
    });
    log(`Started Discord (${app})`);
  }

  async call(cmd) {
    if (!this.sessionId) await this._attach();
    const expression = `(${pageHelper})(${JSON.stringify(cmd)})`;
    let res;
    try {
      res = await this._send({ sessionId: this.sessionId, method: 'Runtime.evaluate', params: { expression, returnByValue: true } });
    } catch (e) {
      this.sessionId = null;
      throw e;
    }
    const exception = res.exceptionDetails;
    if (exception) throw new Error(exception.exception?.description?.split('\n')[0] || exception.text);
    return res.result.value;
  }

  async _attach() {
    const { targetInfos } = await this._send({ method: 'Target.getTargets' });
    const page = targetInfos.find((t) => t.type === 'page' && DISCORD_URL.test(t.url));
    if (!page) throw new Error('Discord is still loading');
    const { sessionId } = await this._send({ method: 'Target.attachToTarget', params: { targetId: page.targetId, flatten: true } });
    this.sessionId = sessionId;
    log('Attached to the Discord window');
  }

  _send(msg, timeoutMs = 5000) {
    if (this.proc?.exitCode !== null) return Promise.reject(new Error('Discord was closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Discord did not respond'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.proc.stdio[3].write(JSON.stringify({ id, ...msg }) + '\0');
    });
  }

  _onData(data) {
    this.buf += data.toString('utf8');
    let end;
    while ((end = this.buf.indexOf('\0')) >= 0) {
      const msg = JSON.parse(this.buf.slice(0, end));
      this.buf = this.buf.slice(end + 1);
      this._onMessage(msg);
    }
  }

  _onMessage(msg) {
    if (msg.method === 'Target.detachedFromTarget' && msg.params.sessionId === this.sessionId) {
      this.sessionId = null;
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result);
  }
}

const describe = (s) => (s.krisp ? 'Krisp' : s.standard ? 'Standard' : 'off');

// ---------- Main loop ----------

async function main() {
  try {
    await acquireLock();
  } catch {
    if (!isSea) console.error('Already running.');
    process.exit(0);
  }
  logStream = fs.createWriteStream(LOG_PATH, { flags: 'w' });
  log(`SoundpadKrisp ${VERSION}`);

  const soundpad = new Soundpad();
  const discord = new Discord();

  // saved is the noise suppression mode from before we turned it off. It is kept on disk in case Discord is closed mid-sound.
  let saved = loadJson(STATE_PATH);
  const setSaved = (state) => {
    saved = state;
    if (state) fs.writeFileSync(STATE_PATH, JSON.stringify(state));
    else fs.rmSync(STATE_PATH, { force: true });
  };
  if (saved) log(`The previous run did not restore noise suppression, restoring: ${describe(saved)}`);

  await discord.launch(() => {
    log('Discord was closed, exiting');
    logStream.end(() => process.exit(0));
  });

  let active = false; // Soundpad is playing (including the release delay)
  let lastPlayAt = 0;
  let soundpadSeen = null;
  let lastError = null;
  let settledSession = null;

  while (true) {
    try {
      // Right after loading, Discord reports Standard for a moment until Krisp initializes.
      // Saving the mode at that point would later restore the wrong one.
      if (!discord.sessionId || discord.sessionId !== settledSession) {
        await discord.call('get');
        await sleep(3000);
        log(`Noise suppression is currently: ${describe(await discord.call('get'))}`);
        settledSession = discord.sessionId;
      }

      const playing = await soundpad.isPlaying();
      if (playing === null) {
        if (soundpadSeen !== false) log('Soundpad is not running, waiting…');
      } else if (soundpadSeen !== true) {
        log('Soundpad found');
      }
      soundpadSeen = playing !== null;

      const now = Date.now();
      if (playing) lastPlayAt = now;
      const shouldBeActive = now - lastPlayAt < config.releaseDelayMs;

      if (shouldBeActive && !active) {
        if (!saved) {
          const state = await discord.call('get');
          if (state.krisp || state.standard) {
            await discord.call('off');
            setSaved(state);
            log(`▶ Soundpad is playing, noise suppression (${describe(state)}) turned off`);
          }
        }
        active = true;
      } else if (!shouldBeActive && active) {
        active = false;
      }

      if (!active && saved) {
        await discord.call(saved);
        log(`■ Soundpad stopped, noise suppression restored: ${describe(saved)}`);
        setSaved(null);
      }

      lastError = null;
      await sleep(config.pollMs);
    } catch (e) {
      if (e.message !== lastError) log('Error:', e.message);
      lastError = e.message;
      active = false;
      await sleep(3000);
    }
  }
}

main().catch((e) => {
  log('Error:', e.message);
  process.exit(1);
});
