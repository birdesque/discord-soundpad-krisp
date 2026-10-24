// Builds dist/discord-soundpad-krisp.exe from src/soundpad-krisp.js as a Node.js single executable application.
//   npm run build
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'build');
const DIST_DIR = path.join(ROOT, 'dist');
const EXE = path.join(DIST_DIR, 'discord-soundpad-krisp.exe');
const MAIN = path.join(BUILD_DIR, 'soundpad-krisp.js');
const BLOB = path.join(BUILD_DIR, 'sea-prep.blob');
const SEA_CONFIG = path.join(BUILD_DIR, 'sea-config.json');
const POSTJECT = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');

if (process.platform !== 'win32') throw new Error('The build must run on Windows');
if (!fs.existsSync(POSTJECT)) throw new Error('postject not found, run npm ci first');

const { version } = require(path.join(ROOT, 'package.json'));
fs.rmSync(BUILD_DIR, { recursive: true, force: true });
fs.mkdirSync(BUILD_DIR, { recursive: true });
fs.mkdirSync(DIST_DIR, { recursive: true });

const source = fs.readFileSync(path.join(ROOT, 'src', 'soundpad-krisp.js'), 'utf8');
fs.writeFileSync(MAIN, source.replace("'__VERSION__'", JSON.stringify(`v${version}`)));
fs.writeFileSync(SEA_CONFIG, JSON.stringify({ main: MAIN, output: BLOB, disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ['--experimental-sea-config', SEA_CONFIG], { stdio: 'inherit' });

fs.copyFileSync(process.execPath, EXE);
execFileSync(
  process.execPath,
  [POSTJECT, EXE, 'NODE_SEA_BLOB', BLOB, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'],
  { stdio: 'inherit' },
);

// Switch the subsystem from console to GUI so no window appears on launch.
// The field is at offset 68 of the Optional Header, which starts 24 bytes after the PE signature.
const exe = fs.readFileSync(EXE);
const peOffset = exe.readUInt32LE(0x3c);
if (exe.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') throw new Error('Not a PE file');
exe.writeUInt16LE(2, peOffset + 24 + 68);
fs.writeFileSync(EXE, exe);

const hash = crypto.createHash('sha256').update(exe).digest('hex');
fs.writeFileSync(`${EXE}.sha256`, `${hash}  ${path.basename(EXE)}\n`);
fs.rmSync(BUILD_DIR, { recursive: true, force: true });

console.log(`Done: ${EXE}\nSHA-256: ${hash}`);
