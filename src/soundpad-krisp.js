#!/usr/bin/env node
// Запускает Discord и выключает в нём шумодав (Krisp или стандартный), пока SoundPad что-то играет.
//
// Discord запускается с --remote-debugging-pipe: канал отладки есть только у этого процесса, сетевого порта нет.
// Обратная сторона: Chromium закрывается, когда канал рвётся, поэтому Discord живёт, пока живёт этот процесс.
// Когда Discord закрывают, процесс тоже завершается.
'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

let isSea = false;
try {
  isSea = require('node:sea').isSea();
} catch {}

// Сборщик подставляет сюда версию из package.json.
const VERSION = '__VERSION__';
const BASE_DIR = isSea ? path.dirname(process.execPath) : process.cwd();
const STATE_PATH = path.join(BASE_DIR, 'soundpad-krisp.state.json');
const LOG_PATH = path.join(BASE_DIR, 'soundpad-krisp.log');
const LOCK_PIPE = '\\\\.\\pipe\\soundpad-krisp-lock';
const DISCORD_URL = /^https:\/\/([a-z]+\.)?discord\.com\//;

function loadJson(file) {
  try {
    // Блокнот сохраняет UTF-8 с BOM, а JSON.parse на нём падает.
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
  const line = `${new Date().toLocaleTimeString('ru-RU')} ${args.join(' ')}`;
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

// Второй экземпляр закрыл бы Discord, запущенный первым, поэтому держим именованный канал как блокировку.
function acquireLock() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error('Уже запущено')));
    server.listen(LOCK_PIPE, () => resolve(server));
  });
}

// ---------- SoundPad ----------

class SoundPad {
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
      this._settle(new Error('SoundPad закрыл соединение'));
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

  // Запросы идут строго по одному: протокол «запрос — ответ» без идентификаторов.
  async request(command, timeoutMs = 1000) {
    if (!this.sock) await this.connect();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._settle(new Error('SoundPad не ответил'));
        this.sock?.destroy();
      }, timeoutMs);
      this.pending = { resolve, reject, timer };
      this.sock.write(command);
    });
  }

  // null — SoundPad недоступен (не запущен).
  async isPlaying() {
    try {
      const status = (await this.request('GetPlayStatus()')).trim();
      return status === 'PLAYING' || status === 'SEEKING';
    } catch {
      return null;
    }
  }
}

// ---------- Discord (Chrome DevTools Protocol через pipe) ----------

// Выполняется внутри окна Discord. Ищет среди модулей rspack действия и хранилище настроек звука.
// cmd: 'get' — прочитать состояние, 'off' — выключить всё, { krisp, standard } — восстановить.
function pageHelper(cmd) {
  if (!window.webpackChunkdiscord_app) throw new Error('Discord ещё загружается');
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
    if (!actions || !store) throw new Error('Не нашёл модули шумодава — похоже, Discord обновился');
    window.__soundpadNS = { actions, store };
  }

  const { actions, store } = window.__soundpadNS;
  const target = cmd === 'off' ? { krisp: false, standard: false } : cmd;
  if (target && typeof target === 'object') {
    // setNoiseCancellation(x) сам ставит стандартный шумодав в !x, поэтому стандартный выставляем после.
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
    if (!app) throw new Error(`Не нашёл Discord в ${root}`);

    if (isDiscordRunning()) {
      log('Discord уже запущен — перезапускаю его с каналом отладки');
      try {
        execFileSync('taskkill', ['/IM', 'Discord.exe', '/F'], { stdio: 'ignore' });
      } catch {}
      for (let i = 0; i < 50 && isDiscordRunning(); i++) await sleep(200);
    }

    // Chromium читает команды из fd 3 и пишет ответы в fd 4.
    this.proc = spawn(path.join(root, app, 'Discord.exe'), ['--remote-debugging-pipe'], {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    });
    this.proc.stdio[3].on('error', () => {});
    this.proc.stdio[4].on('data', (data) => this._onData(data));
    this.proc.on('exit', () => {
      for (const { reject } of this.pending.values()) reject(new Error('Discord закрыт'));
      this.pending.clear();
      onExit();
    });
    log(`Запустил Discord (${app})`);
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
    if (!page) throw new Error('Discord ещё загружается');
    const { sessionId } = await this._send({ method: 'Target.attachToTarget', params: { targetId: page.targetId, flatten: true } });
    this.sessionId = sessionId;
    log('Подключился к окну Discord');
  }

  _send(msg, timeoutMs = 5000) {
    if (this.proc?.exitCode !== null) return Promise.reject(new Error('Discord закрыт'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Discord не ответил'));
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

const describe = (s) => (s.krisp ? 'Krisp' : s.standard ? 'Стандартный' : 'выключен');

// ---------- Основной цикл ----------

async function main() {
  try {
    await acquireLock();
  } catch {
    if (!isSea) console.error('Уже запущено.');
    process.exit(0);
  }
  logStream = fs.createWriteStream(LOG_PATH, { flags: 'w' });
  log(`SoundpadKrisp ${VERSION}`);

  const soundpad = new SoundPad();
  const discord = new Discord();

  // saved — режим шумодава до того, как мы его выключили. Лежит в файле на случай, если Discord закроют посреди звука.
  let saved = loadJson(STATE_PATH);
  const setSaved = (state) => {
    saved = state;
    if (state) fs.writeFileSync(STATE_PATH, JSON.stringify(state));
    else fs.rmSync(STATE_PATH, { force: true });
  };
  if (saved) log(`Прошлый запуск не успел вернуть шумодав — верну: ${describe(saved)}`);

  await discord.launch(() => {
    log('Discord закрыт — выхожу');
    logStream.end(() => process.exit(0));
  });

  let active = false; // SoundPad играет (с учётом задержки отпускания)
  let lastPlayAt = 0;
  let soundpadSeen = null;
  let lastError = null;
  let settledSession = null;

  while (true) {
    try {
      // Сразу после загрузки Discord пару секунд показывает «Стандартный», пока не проинициализируется Krisp.
      // Если в это время запомнить режим, потом вернётся неправильный.
      if (!discord.sessionId || discord.sessionId !== settledSession) {
        await discord.call('get');
        await sleep(3000);
        log(`Шумодав сейчас: ${describe(await discord.call('get'))}`);
        settledSession = discord.sessionId;
      }

      const playing = await soundpad.isPlaying();
      if (playing === null) {
        if (soundpadSeen !== false) log('SoundPad не запущен — жду…');
      } else if (soundpadSeen !== true) {
        log('SoundPad найден');
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
            log(`▶ SoundPad играет — шумодав (${describe(state)}) выключен`);
          }
        }
        active = true;
      } else if (!shouldBeActive && active) {
        active = false;
      }

      if (!active && saved) {
        await discord.call(saved);
        log(`■ SoundPad затих — шумодав снова: ${describe(saved)}`);
        setSaved(null);
      }

      lastError = null;
      await sleep(config.pollMs);
    } catch (e) {
      if (e.message !== lastError) log('Ошибка:', e.message);
      lastError = e.message;
      active = false;
      await sleep(3000);
    }
  }
}

main().catch((e) => {
  log('Ошибка:', e.message);
  process.exit(1);
});
