
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { URL } = require('url');
const { Correlator, DEFAULT_FILTER } = require('./parser');

const APP_DIR = __dirname;
const PORT = Number(process.env.PORT || 8787);
const LISTEN_HOST = process.env.LISTEN_HOST || '127.0.0.1';
const CONFIG_FILE = path.join(APP_DIR, 'p3-config.json');

const defaultConfig = {
  printerIp: process.env.PRINTER_IP || '10.194.23.205',
  sshUser: process.env.SSH_USER || 'root',
  sshPassword: '',
  listenHost: LISTEN_HOST,
  port: PORT,
  liveLogPath: process.env.P3_LOG_PATH || '',
  logPollMs: 1000,
  ntcliPollMs: 30000,
  paperPathFilter: DEFAULT_FILTER,
  maxPages: 2000,
  maxEvents: 12000,
  theme: 'light'
};

let config = loadConfig();
let tailer = null;
let ntcliState = {
  state: 'OFFLINE',
  lastSuccess: null,
  lastAttempt: null,
  latencyMs: null,
  printerIp: config.printerIp,
  errorMessage: null,
  data: null
};

function loadConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { ...defaultConfig, ...parsed, paperPathFilter: DEFAULT_FILTER };
  } catch {
    return { ...defaultConfig };
  }
}

async function saveConfig(next) {
  const safe = {
    ...config,
    ...next,
    paperPathFilter: DEFAULT_FILTER,
    port: Number(next.port ?? config.port),
    logPollMs: Math.max(250, Number(next.logPollMs ?? config.logPollMs)),
    ntcliPollMs: Math.max(5000, Number(next.ntcliPollMs ?? config.ntcliPollMs)),
    maxPages: Math.max(100, Number(next.maxPages ?? config.maxPages)),
    maxEvents: Math.max(1000, Number(next.maxEvents ?? config.maxEvents))
  };
  delete safe.sshPassword; // Never persist credentials from the browser.
  config = safe;
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  restartTailer();
  scheduleNtcli();
  return config;
}

function isPrivateIPv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
  if (!m) return false;
  const p = m.slice(1).map(Number);
  if (p.some(x => x < 0 || x > 255)) return false;
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const b = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(b),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(b);
}

function parseJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (Buffer.byteLength(data) > limit) {
        reject(new Error('Request too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(new Error('Invalid JSON body.')); }
    });
    req.on('error', reject);
  });
}

function runCommand(executable, args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      timeout: timeoutMs,
      maxBuffer: 24 * 1024 * 1024,
      encoding: 'utf8'
    }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(String(stderr || stdout || err.message || 'Command failed').trim());
        e.code = err.code; e.signal = err.signal; e.killed = err.killed;
        reject(e);
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

const NTCLI_COMMAND = [
  'echo "=== Settings ==="',
  'ntcli get Settings',
  'echo "=== Status ==="',
  'ntcli get Status',
  'echo "=== Supplies ==="',
  'ntcli get Supplies',
  'echo "=== Destination ==="',
  'ntcli get Destination'
].join('; ');

function parseJsonish(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { return trimmed; }
}

function parseSections(stdout) {
  const names = ['Settings', 'Status', 'Supplies', 'Destination'];
  const result = {};
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const start = stdout.indexOf(`=== ${name} ===`);
    const endMarker = names[i + 1] ? `=== ${names[i + 1]} ===` : null;
    if (start < 0) { result[name.toLowerCase()] = null; continue; }
    const from = start + (`=== ${name} ===`).length;
    const end = endMarker ? stdout.indexOf(endMarker, from) : stdout.length;
    result[name.toLowerCase()] = parseJsonish(stdout.slice(from, end < 0 ? stdout.length : end));
  }
  return result;
}

async function fetchNtcli(ip) {
  const opts = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=7',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=2'
  ];
  const dest = `${config.sshUser}@${ip}`;
  const start = Date.now();
  let stdout;
  const password = process.env.SSH_PASSWORD || config.sshPassword || '';
  if (password) {
    stdout = await runCommand('sshpass', ['-p', password, 'ssh', ...opts, dest, NTCLI_COMMAND], 15000);
  } else {
    stdout = await runCommand('ssh', ['-o', 'BatchMode=yes', ...opts, dest, NTCLI_COMMAND], 15000);
  }
  const sections = parseSections(stdout);
  return {
    ok: true,
    ip,
    fetchedAt: new Date().toISOString(),
    latencyMs: Date.now() - start,
    ...sections
  };
}

function extractCurrentStage(snapshot) {
  const events = snapshot.events || [];
  const eligible = events.filter(e =>
    e.pageIdHex &&
    ['pageStage', 'staging', 'slpq', 'qdmg', 'pick', 'finishState'].includes(e.type)
  );
  const last = eligible.sort((a, b) => (a.engineTime ?? -Infinity) - (b.engineTime ?? -Infinity)).at(-1);
  if (!last) return null;
  if (last.type === 'pageStage') return { key: last.stage, label: last.stageLabel || last.stage };
  if (last.type === 'staging') return { key: 'staging', label: `Staging · ${last.zone}` };
  if (last.type === 'slpq') return { key: 'slpq', label: 'SLPQ' };
  if (last.type === 'qdmg') return { key: 'qdmg', label: 'QDMG' };
  if (last.type === 'pick') return { key: 'pick', label: 'Pick Page' };
  return { key: 'finish', label: 'Finishing' };
}

class IncrementalTailer {
  constructor(filePath, options) {
    this.path = filePath || '';
    this.parser = new Correlator(options);
    this.offset = 0;
    this.remainder = '';
    this.fileIdentity = null;
    this.sourceStatus = 'OFFLINE';
    this.error = null;
    this.lastReadAt = null;
    this.lastEngineTime = null;
    this.lastLineNumber = 0;
    this.watchTimer = null;
  }

  start() {
    this.stop();
    if (!this.path) {
      this.sourceStatus = 'OFFLINE';
      this.error = null;
      return;
    }
    this.watchTimer = setInterval(() => this.tick().catch(() => {}), Math.max(250, config.logPollMs));
    this.tick().catch(() => {});
  }

  stop() {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  async tick() {
    const filePath = this.path;
    try {
      const st = await fsp.stat(filePath);
      const identity = `${st.dev}:${st.ino}:${st.mtimeMs < 1 ? st.ctimeMs : ''}`;
      if (this.fileIdentity && identity !== this.fileIdentity && st.size < this.offset) {
        this.offset = 0; this.remainder = ''; this.parser.reset();
      }
      if (st.size < this.offset) {
        this.offset = 0; this.remainder = ''; this.parser.reset();
      }
      this.fileIdentity = identity;

      if (st.size > this.offset) {
        const fh = await fsp.open(filePath, 'r');
        const len = st.size - this.offset;
        const buf = Buffer.allocUnsafe(len);
        await fh.read(buf, 0, len, this.offset);
        await fh.close();
        this.offset = st.size;

        const text = this.remainder + buf.toString('utf8');
        const parts = text.split(/\n/);
        this.remainder = parts.pop() || '';
        const deltas = [];
        for (const line of parts) {
          this.lastLineNumber += 1;
          const events = this.parser.addLine(line, this.lastLineNumber);
          if (events?.length) deltas.push(...events);
        }
        if (deltas.length) broadcast({ type: 'delta', events: deltas });
      }
      this.sourceStatus = this.remainder ? 'LIVE' : 'LIVE';
      this.error = null;
      this.lastReadAt = new Date().toISOString();
    } catch (e) {
      this.sourceStatus = e.code === 'ENOENT' ? 'FILE NOT FOUND' : 'READ ERROR';
      this.error = e.message;
    }
  }

  snapshot() {
    const snap = this.parser.snapshot();
    return {
      sourceStatus: this.sourceStatus,
      path: this.path,
      offset: this.offset,
      lastReadAt: this.lastReadAt,
      error: this.error,
      ...snap
    };
  }

  page(pageId) {
    const id = String(pageId || '').toUpperCase().replace(/^0X/, '0x');
    const snapPage = this.parser.snapshot().pages.find(p => p.pageIdHex === id);
    return snapPage || null;
  }
}

function restartTailer() {
  if (tailer) tailer.stop();
  tailer = new IncrementalTailer(config.liveLogPath, {
    filterText: config.paperPathFilter,
    maxPages: config.maxPages,
    maxEvents: config.maxEvents
  });
  tailer.start();
}

let ntcliTimer = null;
let ntcliInFlight = false;
function scheduleNtcli() {
  if (ntcliTimer) clearInterval(ntcliTimer);
  ntcliTimer = setInterval(() => pollNtcli().catch(() => {}), Math.max(5000, config.ntcliPollMs));
  pollNtcli().catch(() => {});
}

async function pollNtcli() {
  if (ntcliInFlight) return;
  ntcliInFlight = true;
  const attemptedAt = new Date();
  ntcliState = { ...ntcliState, state: 'CONNECTING', lastAttempt: attemptedAt.toISOString(), printerIp: config.printerIp };
  try {
    if (!isPrivateIPv4(config.printerIp)) throw new Error('Printer IP must be a private IPv4 address.');
    const data = await fetchNtcli(config.printerIp);
    ntcliState = {
      state: 'LIVE',
      lastSuccess: data.fetchedAt,
      lastAttempt: attemptedAt.toISOString(),
      latencyMs: data.latencyMs,
      printerIp: data.ip,
      errorMessage: null,
      data
    };
    broadcast({ type: 'ntcli', state: ntcliState });
  } catch (e) {
    ntcliState = {
      ...ntcliState,
      state: ntcliState.lastSuccess ? 'STALE' : 'ERROR',
      lastAttempt: attemptedAt.toISOString(),
      errorMessage: e.message
    };
    broadcast({ type: 'ntcli', state: ntcliState });
  } finally {
    ntcliInFlight = false;
  }
}

const sseClients = new Set();
const wsClients = new Set();

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const res of sseClients) {
    try { res.write(`data: ${data}\n\n`); } catch { sseClients.delete(res); }
  }
  for (const sock of wsClients) {
    try { sendWsText(sock, data); } catch { wsClients.delete(sock); try { sock.destroy(); } catch {} }
  }
}

function addCorsAndNoCache(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
}

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

function sendWsFrame(socket, opcode, payload) {
  const data = Buffer.from(payload);
  let header;
  if (data.length < 126) {
    header = Buffer.alloc(2); header[0] = 0x80 | opcode; header[1] = data.length;
  } else if (data.length < 65536) {
    header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  socket.write(Buffer.concat([header, data]));
}
function sendWsText(socket, text) { sendWsFrame(socket, 1, text); }
function handleWsUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${wsAccept(key)}`
  ];
  socket.write(headers.join('\r\n') + '\r\n\r\n');
  socket.setTimeout(0);
  wsClients.add(socket);
  sendWsText(socket, JSON.stringify({ type: 'snapshot', live: tailer?.snapshot(), ntcli: ntcliState }));
  socket.on('close', () => wsClients.delete(socket));
  socket.on('error', () => wsClients.delete(socket));
  socket.on('data', buffer => {
    // Minimal frame handling: support masked client close/ping without
    // implementing a full application-message parser.
    if (!buffer.length) return;
    const opcode = buffer[0] & 0x0f;
    if (opcode === 0x8) {
      try { sendWsFrame(socket, 0x8, ''); } catch {}
      socket.end(); wsClients.delete(socket);
    } else if (opcode === 0x9) {
      try { sendWsFrame(socket, 0xA, ''); } catch {}
    }
  });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  addCorsAndNoCache(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS'
    }); res.end(); return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    send(res, 200, {
      ok: true, service: 'P3 Paper Path Pulse', timestamp: new Date().toISOString(),
      live: tailer?.snapshot()?.sourceStatus || 'OFFLINE',
      ntcli: ntcliState.state
    }); return;
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    send(res, 200, { ok: true, config: { ...config, sshPasswordSet: Boolean(process.env.SSH_PASSWORD || config.sshPassword), sshPassword: undefined } }); return;
  }

  if (req.method === 'PUT' && url.pathname === '/api/config') {
    try {
      const body = await parseJsonBody(req);
      if (body.printerIp && !isPrivateIPv4(body.printerIp)) throw new Error('Printer IP must be a private IPv4 address.');
      const next = { ...body, paperPathFilter: DEFAULT_FILTER };
      delete next.sshPassword;
      const saved = await saveConfig(next);
      send(res, 200, { ok: true, config: { ...saved, sshPassword: undefined, sshPasswordSet: Boolean(process.env.SSH_PASSWORD || saved.sshPassword) } });
    } catch (e) { send(res, 400, { ok: false, error: e.message }); }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/ntcli') {
    await pollNtcli();
    send(res, ntcliState.state === 'ERROR' ? 502 : 200, ntcliState);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/live/summary') {
    const snap = tailer?.snapshot() || { sourceStatus: 'OFFLINE', pages: [], events: [], stats: {} };
    const pages = snap.pages || [];
    const current = pages[0] || null;
    const currentStage = extractCurrentStage(snap);
    const latestIpe = [...(snap.events || [])].reverse().find(e => e.type === 'pageStage' && e.ipeMm != null) || null;
    const latestQ = [...(snap.events || [])].reverse().find(e => e.type === 'qdmg') || null;
    send(res, 200, {
      ok: true, sourceStatus: snap.sourceStatus, log: { path: config.liveLogPath, lastReadAt: snap.lastReadAt, error: snap.error, stats: snap.stats },
      ntcli: ntcliState,
      currentPage: current?.pageIdHex || null,
      currentStage,
      latestIpe,
      latestQdmg: latestQ,
      health: snap.health,
      pages: pages.slice(0, 80)
    }); return;
  }

  if (req.method === 'GET' && url.pathname === '/api/live/pages') {
    const snap=tailer?.snapshot() || {sourceStatus:'OFFLINE',pages:[],events:[],stats:{}};
    const limit=Math.max(1,Math.min(500,Number(url.searchParams.get('limit')||200)));
    send(res, 200, { ok: true, ...snap, pages:(snap.pages||[]).slice(0,limit) }); return;
  }

  if (req.method === 'GET' && url.pathname === '/api/live/events') {
    send(res, 200, { ok: true, events: tailer?.snapshot()?.events || [] }); return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/live/page/')) {
    const pageId = decodeURIComponent(url.pathname.slice('/api/live/page/'.length));
    const page = tailer?.page(pageId);
    if (!page) { send(res, 404, { ok: false, error: 'Page not found' }); return; }
    send(res, 200, { ok: true, page }); return;
  }

  if (req.method === 'GET' && url.pathname === '/api/live/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    sseClients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'snapshot', live: tailer?.snapshot(), ntcli: ntcliState })}\n\n`);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/analyze') {
    try {
      const body = await parseJsonBody(req, 40 * 1024 * 1024);
      if (typeof body.text !== 'string') throw new Error('body.text must be a string');
      const parser = new Correlator({
        filterText: DEFAULT_FILTER,
        maxPages: 5000,
        maxEvents: 50000
      });
      const lines = body.text.split(/\n/);
      for (let i = 0; i < lines.length; i++) parser.addLine(lines[i], i + 1);
      send(res, 200, { ok: true, filename: body.filename || 'analysis.log', ...parser.finalize() });
    } catch (e) { send(res, 400, { ok: false, error: e.message }); }
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const file = path.join(APP_DIR, 'index.html');
    if (!fs.existsSync(file)) { send(res, 500, { ok: false, error: 'index.html missing' }); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res); return;
  }

  if (req.method === 'GET' && url.pathname === '/p3-worker.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    fs.createReadStream(path.join(APP_DIR, 'p3-worker.js')).pipe(res); return;
  }

  if (req.method === 'GET' && url.pathname === '/parser.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    fs.createReadStream(path.join(APP_DIR, 'parser.js')).pipe(res); return;
  }

  send(res, 404, { ok: false, error: 'Not found' });
}

const server = http.createServer((req, res) => handle(req, res).catch(e => send(res, 500, { ok: false, error: e.message })));
server.on('upgrade', (req, socket) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (u.pathname === '/ws/live') handleWsUpgrade(req, socket);
  else socket.destroy();
});
server.on('error', e => {
  console.error('Server error:', e);
  process.exit(1);
});

process.on('SIGINT', () => { if (tailer) tailer.stop(); if (ntcliTimer) clearInterval(ntcliTimer); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { if (tailer) tailer.stop(); if (ntcliTimer) clearInterval(ntcliTimer); server.close(() => process.exit(0)); });

server.listen(config.port, config.listenHost, () => {
  restartTailer();
  scheduleNtcli();
  console.log(`P3 — Paper Path Pulse at http://${config.listenHost}:${config.port}/`);
  console.log(`Live log: ${config.liveLogPath || '(not configured)'}`);
});
