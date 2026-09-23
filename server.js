
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT_RAW = process.env.PORT == null || process.env.PORT === '' ? '5076' : String(process.env.PORT).trim();
const PORT = /^\d+$/.test(PORT_RAW) ? parseInt(PORT_RAW, 10) : NaN;
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('[agent-view] PORT must be a whole number 1-65535, got: ' + JSON.stringify(process.env.PORT));
  process.exit(2);
}
const HOST = '127.0.0.1';
const TRANSCRIPTS_DIR = process.env.TRANSCRIPTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const CONSOLE_URL = process.env.CONSOLE_URL || 'http://127.0.0.1:5050/api/agent-status';
const PROJECTS_ROOT = (process.env.PROJECTS_ROOT || path.join(os.homedir(), 'projects')).replace(/\/+$/, '');
const BRAIN_POOL = (process.env.BRAIN_POOL || path.join(os.homedir(), '.agent-memory')).replace(/\/+$/, '');
const PAGE = path.join(__dirname, 'index.html');

const AGENTS = [
  { id: 'prime', name: 'Prime' },
  { id: 'nova', name: 'Nova' },
  { id: 'core', name: 'Core' },
  { id: 'orion', name: 'Orion' },
  { id: 'echo', name: 'Echo' },
  { id: 'astra', name: 'Astra' },
];
const AGENT_IDS = AGENTS.map(a => a.id);
const NAME_BY_ID = new Map(AGENTS.map(a => [a.id, a.name]));
const STATUSES = new Set(['idle', 'active', 'thinking', 'waiting']);

const TRAIL_N = 8;
const TRAIL_TAIL_BYTES = 1024 * 1024;
const TRAIL_TAIL_MAX_BYTES = 8 * 1024 * 1024;
const TRAIL_FRESH_MS = 15 * 60 * 1000;
const TRAIL_LIVE_MS = 20 * 1000;
const SUB_ID_RE = /^[a-z0-9]{6,32}$/;
const SUB_MAX = 8;
const SUB_DONE_KEEP_MS = 60 * 1000;
const SUB_GHOST_MS = 2 * 60 * 1000;
const SUB_PARSE_MIN_MS = 2000;
const SUB_DIR_MS = 2000;
const SUB_SIDECAR_MAX = 4096;
const SUB_CACHE_MAX = 256;
const SUB_SESSIONS = 3;
const SUB_SESSION_MAX = SUB_SESSIONS + 2;
const LIVE_SESS_MAX = 8;
const NOTE_IX_MAX = 8;
const TRAIL_REPARSE_MIN_MS = 5000;
const TRAIL_CACHE_MAX = 48;

const liveSubSessions = new Map();
function noteLiveSession(agentId, file, now) {
  if (!file) return;
  let per = liveSubSessions.get(agentId);
  if (!per) { per = new Map(); liveSubSessions.set(agentId, per); }
  per.delete(file);
  per.set(file, now);
  prune(per, LIVE_SESS_MAX);
}
function isLiveSession(agentId, file, now) {
  const per = liveSubSessions.get(agentId);
  if (!per) return false;
  const at = per.get(file);
  if (at == null) return false;
  if (now - at > TRAIL_FRESH_MS) { per.delete(file); return false; }
  return true;
}
const NOTE_CHUNK = 4 * 1024 * 1024;
const NOTE_MARK = '<task-notification>';
const NOTE_MARK_B = Buffer.from(NOTE_MARK);
const PROJECT_FRESH_MS = 15 * 60 * 1000;
const SNAPSHOT_MEMO_MS = 1000;
const CONSOLE_MEMO_MS = 1000;
const CONSOLE_TIMEOUT_MS = 3000;
const CONSOLE_MAX_BODY = 400000;
const HEARTBEAT_MS = 8000;
const DETAIL_MAX = 60;
const NAME_MAX = 40;

let openMemo = { key: '', val: true };
function canReadNewest(best) {
  let n = null;
  for (const v of best.values()) if (!n || v.mtimeMs > n.mtimeMs) n = v;
  if (!n) return true;
  const key = n.file + '|' + n.mtimeMs + '|' + n.size + '|' + n.ctimeMs;
  if (openMemo.key === key) return openMemo.val;
  let fd = -1;
  let val = true;
  try { fd = fs.openSync(n.file, 'r'); }
  catch (e) { val = !(e && (e.code === 'EACCES' || e.code === 'EPERM')); }
  if (fd >= 0) { try { fs.closeSync(fd); } catch { } }
  openMemo = { key, val };
  return val;
}
function probeTranscripts(now = Date.now()) {
  const s = scanTranscripts(now);
  return { ok: s.ok && canReadNewest(s.best), best: s.best, sessions: s.sessions };
}
let transcriptsOk = probeTranscripts().ok;

function getFleet() {
  return new Promise(resolve => {
    let settled = false;
    const finish = v => { if (!settled) { settled = true; resolve(v); } };
    const dead = { ok: false, agents: [] };
    let target;
    try { target = new URL(CONSOLE_URL); } catch { return finish(dead); }
    const lib = target.protocol === 'https:' ? https : http;
    let call;
    try {
      call = lib.request({
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': 2 },
        agent: false,
      }, r => {
        let out = '';
        r.setEncoding('utf8');
        r.on('data', d => { if (out.length < CONSOLE_MAX_BODY) out += d; });
        r.on('end', () => {
          if (r.statusCode !== 200) return finish(dead);
          try {
            const j = JSON.parse(out);
            if (!Array.isArray(j.agents)) return finish(dead);
            finish({ ok: true, agents: j.agents });
          } catch { finish(dead); }
        });
        r.on('error', () => finish(dead));
      });
    } catch { return finish(dead); }
    call.setTimeout(CONSOLE_TIMEOUT_MS, () => { call.destroy(); finish(dead); });
    call.on('error', () => finish(dead));
    call.end('{}');
  });
}

let fleetCache = { at: 0, val: { ok: false, agents: [] } };
let fleetPending = null;
function fleet(now, maxAge = CONSOLE_MEMO_MS) {
  if (now - fleetCache.at < maxAge) return Promise.resolve(fleetCache.val);
  if (!fleetPending) {
    fleetPending = getFleet().then(v => {
      fleetCache = { at: Date.now(), val: v };
      fleetPending = null;
      return v;
    });
  }
  return fleetPending;
}

function scanTranscripts(now = Date.now()) {
  const best = new Map();
  const fresh = new Map();
  const held = new Map();
  let dirs;
  try { dirs = fs.readdirSync(TRANSCRIPTS_DIR); } catch { return { ok: false, best, sessions: new Map() }; }
  for (const d of dirs) {
    const id = AGENT_IDS.find(x => d.endsWith('-agents-' + x));
    if (!id) continue;
    const dir = path.join(TRANSCRIPTS_DIR, d);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      let st;
      try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
      if (!st.isFile()) continue;
      const e = { file: path.join(dir, f), mtimeMs: st.mtimeMs, size: st.size, ctimeMs: st.ctimeMs };
      const cur = best.get(id);
      if (!cur || e.mtimeMs > cur.mtimeMs) best.set(id, e);
      if (now - e.mtimeMs > TRAIL_FRESH_MS) {
        if (isLiveSession(id, e.file, now)) {
          const kept = held.get(id);
          if (kept) kept.push(e); else held.set(id, [e]);
        }
        continue;
      }
      const list = fresh.get(id);
      if (list) list.push(e); else fresh.set(id, [e]);
    }
  }
  const sessions = new Map();
  for (const id of AGENT_IDS) {
    const list = [];
    const taken = new Set();
    const add = e => {
      if (!e || taken.has(e.file) || list.length >= SUB_SESSION_MAX) return;
      taken.add(e.file);
      list.push(e);
    };
    add(best.get(id));
    const fl = fresh.get(id);
    if (fl) {
      fl.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const e of fl.slice(0, SUB_SESSIONS)) add(e);
    }
    const hl = held.get(id);
    if (hl) {
      hl.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const e of hl) add(e);
    }
    if (list.length) sessions.set(id, list);
  }
  return { ok: true, best, sessions };
}

const trailBase = p => { try { return p ? path.basename(String(p)) : ''; } catch { return ''; } };
const trailHost = u => { try { return u ? new URL(String(u)).hostname : ''; } catch { return ''; } };
function clamp(s, n = DETAIL_MAX) {
  const d = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return d.length > n ? d.slice(0, n - 1) + '…' : d;
}
function isoAt(v) {
  if (typeof v !== 'string') return '';
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const ts = Date.parse(s);
  if (!Number.isFinite(ts)) return '';
  try { return new Date(ts).toISOString(); } catch { return ''; }
}
function trailDetail(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  let d = '';
  switch (name) {
    case 'Bash': d = i.description || ''; break;
    case 'Read': case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': d = trailBase(i.file_path || i.notebook_path); break;
    case 'Grep': case 'Glob': d = i.pattern || ''; break;
    case 'WebSearch': d = i.query || ''; break;
    case 'WebFetch': d = trailHost(i.url); break;
    case 'Agent': case 'Task': d = i.description || ''; break;
    case 'Skill': d = i.skill ? '/' + i.skill : ''; break;
    case 'Artifact': d = i.action || trailBase(i.file_path); break;
    case 'SendMessage': d = i.to ? 'to ' + i.to : ''; break;
    default: d = '';
  }
  return clamp(d);
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Glob']);
const TALK_TOOLS = new Set(['SendMessage', 'SendUserFile', 'AskUserQuestion']);
const under = (p, root) => typeof p === 'string' && root && (p === root || p.startsWith(root + '/'));

function classify(name, i) {
  if (name === 'Bash') {
    const m = /brain\.js\s+(recall|store)\b/.exec(typeof i.command === 'string' ? i.command : '');
    return m ? { kind: 'memory', op: m[1] } : { kind: 'command' };
  }
  if (name === 'Read' || name === 'Grep' || name === 'Glob') {
    if (under(i.file_path, BRAIN_POOL) || under(i.path, BRAIN_POOL)) return { kind: 'memory', op: 'recall' };
  }
  if (name === 'Agent' || name === 'Task') return { kind: 'subagent' };
  if (name === 'WebSearch' || name === 'WebFetch') return { kind: 'web' };
  if (name === 'Skill') return { kind: 'skill' };
  if (TALK_TOOLS.has(name)) return { kind: 'talk' };
  if (name.startsWith('mcp__')) {
    if (name.includes('telegram') && name.endsWith('__reply')) return { kind: 'talk' };
    return { kind: 'mcp' };
  }
  if (FILE_TOOLS.has(name)) return { kind: 'file' };
  if (name === 'Grep') return { kind: 'search' };
  return { kind: 'other' };
}

function projectFromUse(name, i) {
  if (name === 'Skill' && i.skill === 'coordinate') {
    const tok = String(i.args == null ? '' : i.args).trim().split(/\s+/)[0] || '';
    const id = clamp(tok.replace(/^\/+/, ''));
    return id || null;
  }
  if (!PROJECTS_ROOT) return null;
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const v = i[key];
    if (typeof v === 'string' && v.startsWith(PROJECTS_ROOT + '/')) {
      const seg = v.slice(PROJECTS_ROOT.length + 1).split('/')[0];
      if (seg) return clamp(seg);
    }
  }
  return null;
}

const EMPTY_META = { model: '', harness: '', repo: '', branch: '' };
const EMPTY_TRAIL = { tools: [], kindsAt: {}, toolRunning: false, toolsAt: 0, project: null, meta: EMPTY_META };

function harnessOf(entrypoint, version) {
  const e = typeof entrypoint === 'string' ? entrypoint : '';
  const v = typeof version === 'string' && /^[\w.\-]{1,20}$/.test(version) ? version : '';
  const word = e === 'cli' ? 'Claude Code' : /^sdk/.test(e) ? 'Claude Agent SDK' : e ? clamp(e, NAME_MAX) : (v ? 'Claude Code' : '');
  return clamp(word && v ? word + ' ' + v : word);
}
function metaFrom(o, meta) {
  const ts = Date.parse(o.timestamp);
  if (!Number.isFinite(ts)) return;
  const put = (k, v) => { if (v && !(meta[k + 'Ts'] > ts)) { meta[k] = v; meta[k + 'Ts'] = ts; } };
  if (o.message && typeof o.message.model === 'string') put('model', clamp(o.message.model, NAME_MAX));
  if (typeof o.version === 'string' || typeof o.entrypoint === 'string') put('harness', harnessOf(o.entrypoint, o.version));
  if (typeof o.cwd === 'string') put('repo', clamp(trailBase(o.cwd), DETAIL_MAX));
  if (typeof o.gitBranch === 'string') put('branch', clamp(o.gitBranch, NAME_MAX));
}
const RES_ID_RE = /agentId:\s*([a-z0-9]{6,32})\b/;
function resultTextOf(b) {
  if (typeof b.content === 'string') return b.content.slice(0, 500);
  if (Array.isArray(b.content)) {
    for (const c of b.content) if (c && c.type === 'text' && typeof c.text === 'string') return c.text.slice(0, 500);
  }
  return '';
}
function launchFrom(o, b) {
  const r = o && o.toolUseResult && typeof o.toolUseResult === 'object' ? o.toolUseResult : null;
  const txt = resultTextOf(b);
  let id = r && typeof r.agentId === 'string' ? r.agentId.trim() : '';
  if (!SUB_ID_RE.test(id)) {
    const m = RES_ID_RE.exec(txt);
    id = m ? m[1] : '';
  }
  if (!SUB_ID_RE.test(id)) return null;
  const isAsync = r && typeof r.isAsync === 'boolean' ? r.isAsync : /^\s*Async agent launched/.test(txt);
  const model = r && typeof r.resolvedModel === 'string' ? clamp(r.resolvedModel, NAME_MAX) : '';
  return { agentId: id, isAsync: !!isAsync, model };
}
function parseLines(text, results, meta, launched) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (meta && o && typeof o === 'object') metaFrom(o, meta);
    const content = o && o.message && Array.isArray(o.message.content) ? o.message.content : null;
    if (!content) continue;
    const at = isoAt(o.timestamp);
    if (o.type === 'assistant') {
      for (const b of content) {
        if (!b || b.type !== 'tool_use' || !b.name) continue;
        const raw = String(b.name);
        const i = b.input && typeof b.input === 'object' ? b.input : {};
        const c = classify(raw, i);
        const sub = raw === 'Agent' || raw === 'Task';
        out.push({
          id: b.id,
          name: clamp(raw, NAME_MAX),
          detail: trailDetail(raw, i),
          at,
          kind: c.kind,
          op: c.op,
          sub,
          subType: sub ? clamp(i.subagent_type || '') : null,
          proj: projectFromUse(raw, i),
        });
      }
    } else if (o.type === 'user') {
      let first = true;
      for (const b of content) {
        if (!b || b.type !== 'tool_result' || !b.tool_use_id) continue;
        results.set(b.tool_use_id, at);
        if (launched) {
          const L = launchFrom(first ? o : null, b);
          if (L) launched.set(b.tool_use_id, L);
        }
        first = false;
      }
    }
  }
  return out;
}

function parseTail(t) {
  const results = new Map();
  const launched = new Map();
  const meta = {};
  const slabs = [];
  let total = 0;
  let bytesRead = 0;
  let fd;
  try { fd = fs.openSync(t.file, 'r'); } catch { return null; }
  try {
    let end = t.size;
    let carry = Buffer.alloc(0);
    while (end > 0 && total < TRAIL_N && bytesRead < TRAIL_TAIL_MAX_BYTES) {
      const want = Math.min(end, TRAIL_TAIL_BYTES, TRAIL_TAIL_MAX_BYTES - bytesRead);
      const start = end - want;
      const buf = Buffer.alloc(want);
      fs.readSync(fd, buf, 0, want, start);
      bytesRead += want;
      end = start;
      const combined = carry.length ? Buffer.concat([buf, carry]) : buf;
      let body = combined;
      if (start > 0) {
        const nl = combined.indexOf(10);
        if (nl === -1) { carry = combined; continue; }
        carry = combined.subarray(0, nl);
        body = combined.subarray(nl + 1);
      } else {
        carry = Buffer.alloc(0);
      }
      const slab = parseLines(body.toString('utf8'), results, meta, launched);
      total += slab.length;
      slabs.push(slab);
    }
  } catch { return null; }
  finally { try { fs.closeSync(fd); } catch { } }

  const uses = [];
  for (let s = slabs.length - 1; s >= 0; s--) for (const u of slabs[s]) uses.push(u);
  const cardMeta = { model: meta.model || '', harness: meta.harness || '', repo: meta.repo || '', branch: meta.branch || '' };
  if (!uses.length) return { ...EMPTY_TRAIL, parsed: true, meta: cardMeta, launches: [] };

  const tail = uses.slice(-TRAIL_N);
  const last = tail[tail.length - 1];
  const unanswered = !!last.id && !results.has(last.id);

  const tools = tail.map(u => {
    const o = { name: u.name, detail: u.detail, at: u.at, kind: u.kind };
    if (u.kind === 'memory') o.op = u.op || 'recall';
    return o;
  });

  const kindsAt = {};
  for (const u of uses) {
    if (!u.at) continue;
    const cur = kindsAt[u.kind];
    if (!cur || Date.parse(u.at) >= Date.parse(cur)) kindsAt[u.kind] = u.at;
  }

  const launches = uses.filter(u => u.sub).map(u => {
    const L = u.id ? launched.get(u.id) : null;
    return {
      toolUseId: u.id || '',
      type: u.subType || '',
      detail: u.detail,
      at: u.at,
      agentId: L ? L.agentId : '',
      isAsync: L ? L.isAsync : false,
      resModel: L ? L.model : '',
      resultAt: u.id && results.has(u.id) ? results.get(u.id) : '',
    };
  });

  let project = null;
  for (const u of uses) if (u.proj) project = { id: u.proj, at: u.at };

  return { tools, kindsAt, launches, project, unanswered, parsed: true, meta: cardMeta };
}

const trailCache = new Map();

function parsedFor(stat, now = Date.now()) {
  const c = trailCache.get(stat.file);
  if (c && c.size === stat.size && (c.parsedMtimeMs === stat.mtimeMs || now - c.at < TRAIL_REPARSE_MIN_MS)) {
    c.mtimeMs = stat.mtimeMs;
    return c;
  }
  const parsed = parseTail(stat);
  if (!parsed) return c || null;
  const v = { size: stat.size, parsedMtimeMs: stat.mtimeMs, mtimeMs: stat.mtimeMs, at: now, parsed };
  trailCache.set(stat.file, v);
  prune(trailCache, TRAIL_CACHE_MAX);
  return v;
}

function trailFor(agentId, stat, now) {
  if (!stat) return EMPTY_TRAIL;
  if (now - stat.mtimeMs > TRAIL_FRESH_MS) return EMPTY_TRAIL;
  const c = parsedFor(stat, now);
  if (!c) return EMPTY_TRAIL;
  const p = c.parsed;
  if (!p.tools.length) return EMPTY_TRAIL;
  let project = null;
  if (p.project && p.project.at) {
    const ts = Date.parse(p.project.at);
    if (Number.isFinite(ts) && now - ts <= PROJECT_FRESH_MS) project = p.project;
  }
  return {
    tools: p.tools,
    kindsAt: p.kindsAt || {},
    toolRunning: p.unanswered || (now - c.mtimeMs < TRAIL_LIVE_MS),
    toolsAt: Math.round(c.mtimeMs),
    project,
    meta: p.meta || EMPTY_META,
  };
}

function prune(m, max = SUB_CACHE_MAX) {
  if (m.size <= max) return;
  for (const k of m.keys()) { m.delete(k); if (m.size <= max) break; }
}

let noteScans = 0;
let noteBytes = 0;
let subParses = 0;
let subParseFails = 0;
let sidecarReads = 0;
const noteIndexes = new Map();

function takeNotice(ix, line) {
  let o;
  try { o = JSON.parse(line); } catch { return; }
  if (!o || typeof o !== 'object') return;
  if (o.type === 'assistant') return;
  let text = '';
  if (typeof o.content === 'string') text = o.content;
  else if (o.attachment && typeof o.attachment.prompt === 'string') text = o.attachment.prompt;
  else if (o.message && typeof o.message.content === 'string') text = o.message.content;
  else if (o.message && Array.isArray(o.message.content)) {
    for (const b of o.message.content) if (b && b.type === 'text' && typeof b.text === 'string') { text = b.text; break; }
  }
  if (!text || text.indexOf(NOTE_MARK) === -1) return;
  const idm = /<task-id>([a-z0-9]{6,32})<\/task-id>/.exec(text);
  if (!idm) return;
  const sm = /<status>([A-Za-z_-]{1,24})<\/status>/.exec(text);
  const um = /<tool-use-id>([A-Za-z0-9_-]{1,80})<\/tool-use-id>/.exec(text);
  const at = isoAt(o.timestamp);
  const status = sm && sm[1] === 'completed' ? 'done' : 'failed';
  const prev = ix.byTask.get(idm[1]);
  const earlier = !prev || (!prev.at && at) || (at && prev.at && Date.parse(at) < Date.parse(prev.at));
  if (earlier) ix.byTask.set(idm[1], { status, at });
  if (um) ix.byUse.set(um[1], idm[1]);
  prune(ix.byTask, 4096);
  prune(ix.byUse, 4096);
}

function scanNotices(ix, size) {
  let fd;
  try { fd = fs.openSync(ix.file, 'r'); } catch { return; }
  noteScans++;
  try {
    let pos = ix.scannedTo;
    let scanned = pos;
    let regionStart = pos;
    let region = Buffer.alloc(0);
    while (pos < size) {
      const want = Math.min(NOTE_CHUNK, size - pos);
      const buf = Buffer.alloc(want);
      let got = 0;
      try { got = fs.readSync(fd, buf, 0, want, pos); } catch { break; }
      if (got <= 0) break;
      pos += got;
      noteBytes += got;
      region = region.length ? Buffer.concat([region, buf.subarray(0, got)]) : buf.subarray(0, got);
      const lastNl = region.lastIndexOf(10);
      if (lastNl === -1) continue;
      const complete = region.subarray(0, lastNl);
      let from = 0;
      for (;;) {
        const hit = complete.indexOf(NOTE_MARK_B, from);
        if (hit === -1) break;
        let s = complete.lastIndexOf(10, hit);
        s = s === -1 ? 0 : s + 1;
        let e = complete.indexOf(10, hit);
        if (e === -1) e = complete.length;
        takeNotice(ix, complete.toString('utf8', s, e));
        from = e + 1;
      }
      regionStart += lastNl + 1;
      scanned = regionStart;
      region = region.subarray(lastNl + 1);
    }
    ix.scannedTo = scanned;
  } finally { try { fs.closeSync(fd); } catch { } }
}

function noteIndexFor(agentId, stat) {
  let per = noteIndexes.get(agentId);
  if (!per) { per = new Map(); noteIndexes.set(agentId, per); }
  let ix = per.get(stat.file);
  if (!ix || stat.size < ix.scannedTo) {
    ix = { file: stat.file, scannedTo: 0, examinedSize: -1, byTask: new Map(), byUse: new Map() };
    per.set(stat.file, ix);
    prune(per, NOTE_IX_MAX);
  } else {
    per.delete(stat.file);
    per.set(stat.file, ix);
  }
  if (stat.size !== ix.examinedSize) {
    if (stat.size > ix.scannedTo) scanNotices(ix, stat.size);
    ix.examinedSize = stat.size;
  }
  return ix;
}

const subStatus = new Map();

const sidecarCache = new Map();
function readSidecar(file, mtimeMs) {
  const c = sidecarCache.get(file);
  if (c && c.mtimeMs === mtimeMs) return c.val;
  const val = parseSidecar(file);
  sidecarCache.set(file, { mtimeMs, val });
  prune(sidecarCache);
  return val;
}
function parseSidecar(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  sidecarReads++;
  try {
    const b = Buffer.alloc(SUB_SIDECAR_MAX);
    const n = fs.readSync(fd, b, 0, SUB_SIDECAR_MAX, 0);
    const o = JSON.parse(b.toString('utf8', 0, n));
    if (!o || typeof o !== 'object') return null;
    return {
      type: clamp(typeof o.agentType === 'string' ? o.agentType : '', DETAIL_MAX),
      detail: clamp(typeof o.description === 'string' ? o.description : '', DETAIL_MAX),
      model: typeof o.model === 'string' && o.model ? clamp(o.model + ' (requested)', NAME_MAX) : '',
      toolUseId: typeof o.toolUseId === 'string' ? o.toolUseId.slice(0, 80) : '',
    };
  } catch { return null; }
  finally { try { fs.closeSync(fd); } catch { } }
}

const subDirs = new Map();
function subDirFor(stat, now) {
  const dir = path.join(path.dirname(stat.file), path.basename(stat.file, '.jsonl'), 'subagents');
  const c = subDirs.get(dir);
  if (c && now - c.at < SUB_DIR_MS) return c;
  const subs = new Map();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { names = []; }
  for (const n of names) {
    const m = /^agent-([a-z0-9]{6,32})(\.jsonl|\.meta\.json)$/.exec(n);
    if (!m) continue;
    let st;
    try { st = fs.statSync(path.join(dir, n)); } catch { continue; }
    if (!st.isFile()) continue;
    const e = subs.get(m[1]) || { jsonl: '', jsonlAt: 0, size: 0, meta: '', metaAt: 0 };
    if (m[2] === '.jsonl') { e.jsonl = path.join(dir, n); e.jsonlAt = st.mtimeMs; e.size = st.size; }
    else { e.meta = path.join(dir, n); e.metaAt = st.mtimeMs; }
    subs.set(m[1], e);
  }
  const v = { at: now, dir, subs };
  subDirs.set(dir, v);
  prune(subDirs);
  return v;
}

const subCache = new Map();
const subFails = new Map();
function subTrail(id, file, mtimeMs, size, now) {
  const key = file + '|' + mtimeMs + '|' + size;
  const c = subCache.get(id);
  if (c && (c.key === key || now - c.at < SUB_PARSE_MIN_MS)) return c;
  const failedAt = subFails.get(key);
  if (failedAt != null && now - failedAt < SUB_PARSE_MIN_MS) return c || null;
  const parsed = parseTail({ file, size });
  if (!parsed) {
    subParseFails++;
    subFails.set(key, now);
    prune(subFails);
    return c || null;
  }
  subFails.delete(key);
  subParses++;
  const v = { key, at: now, parsed };
  subCache.set(id, v);
  prune(subCache);
  return v;
}

function subsFor(agentId, sessions, now) {
  if (!sessions || !sessions.length) return [];
  const rows = new Map();
  for (const stat of sessions) {
    let c = null;
    try { c = parsedFor(stat, now); } catch { c = null; }
    const launches = c && c.parsed && Array.isArray(c.parsed.launches) ? c.parsed.launches : [];
    const pmeta = c && c.parsed ? (c.parsed.meta || EMPTY_META) : EMPTY_META;
    let dir;
    try { dir = subDirFor(stat, now); } catch { dir = { subs: new Map() }; }
    if (!launches.length && !dir.subs.size) continue;
    let ix;
    try { ix = noteIndexFor(agentId, stat); } catch { ix = { byTask: new Map(), byUse: new Map() }; }

    const local = new Map();
    for (const [id, e] of dir.subs) {
      const side = e.meta ? readSidecar(e.meta, e.metaAt) : null;
      const stamp = e.metaAt || e.jsonlAt || 0;
      local.set(id, {
        id,
        type: side ? side.type : '',
        detail: side ? side.detail : '',
        at: stamp ? isoAt(new Date(stamp).toISOString()) : '',
        seen: Math.max(e.jsonlAt, e.metaAt),
        file: e.jsonl, mtimeMs: e.jsonlAt, size: e.size, metaAt: e.metaAt,
        resModel: '', reqModel: side ? side.model : '',
        toolUseId: side ? side.toolUseId : '',
        isAsync: true, resultAt: '',
      });
    }
    for (const L of launches) {
      if (!SUB_ID_RE.test(L.agentId)) continue;
      const r = local.get(L.agentId) || {
        id: L.agentId, type: '', detail: '', at: '', seen: 0,
        file: '', mtimeMs: 0, size: 0, metaAt: 0, resModel: '', reqModel: '', toolUseId: '', isAsync: false, resultAt: '',
      };
      if (L.type) r.type = L.type;
      if (L.detail) r.detail = L.detail;
      if (L.at) r.at = L.at;
      if (L.resModel) r.resModel = L.resModel;
      if (L.toolUseId) r.toolUseId = L.toolUseId;
      r.isAsync = L.isAsync;
      r.resultAt = L.resultAt;
      const lt = Date.parse(L.at);
      if (Number.isFinite(lt)) r.seen = Math.max(r.seen, lt);
      local.set(L.agentId, r);
    }
    for (const [id, r] of local) {
      if (rows.has(id)) continue;
      let note = ix.byTask.get(id) || null;
      if (!note && r.toolUseId) {
        const via = ix.byUse.get(r.toolUseId);
        if (via) note = ix.byTask.get(via) || null;
      }
      r.note = note;
      r.pharness = pmeta.harness || '';
      r.src = stat.file;
      rows.set(id, r);
    }
  }

  const out = [];
  const srcById = new Map();
  const nowIso = new Date(now).toISOString();
  for (const r of rows.values()) {
    let status = 'running';
    let doneAt = '';
    if (r.note) { status = r.note.status; doneAt = r.note.at; }
    else if (!r.isAsync && r.resultAt) { status = 'done'; doneAt = r.resultAt; }
    const prev = subStatus.get(r.id);
    if (prev) { status = prev.status; doneAt = prev.doneAt; }
    else if (status !== 'running') {
      const ts = Date.parse(doneAt);
      if (!Number.isFinite(ts) || ts > now) doneAt = nowIso;
      subStatus.set(r.id, { status, doneAt });
      prune(subStatus);
    }

    if (status !== 'running') {
      const doneTs = Date.parse(doneAt);
      const age = now - Math.min(Number.isFinite(doneTs) ? doneTs : now, now);
      if (age > SUB_DONE_KEEP_MS) continue;
    } else {
      const seen = Math.max(r.seen, r.mtimeMs, Date.parse(r.at) || 0);
      const onDisk = r.mtimeMs > 0 || r.metaAt > 0;
      if (!seen || now - seen > (onDisk ? TRAIL_FRESH_MS : SUB_GHOST_MS)) continue;
    }

    let tools = [], toolRunning = false, toolsAt = 0;
    let model = '', harness = '', repo = '', branch = '';
    if (r.file) {
      let fst = null;
      try { fst = fs.statSync(r.file); } catch { fst = null; }
      const mtimeMs = fst ? fst.mtimeMs : r.mtimeMs;
      const size = fst ? fst.size : r.size;
      const s = subTrail(r.id, r.file, mtimeMs, size, now);
      if (s && s.parsed) {
        tools = s.parsed.tools || [];
        toolRunning = !!s.parsed.unanswered || (now - mtimeMs < TRAIL_LIVE_MS);
        toolsAt = Math.round(mtimeMs);
        const m = s.parsed.meta || EMPTY_META;
        model = m.model; harness = m.harness; repo = m.repo; branch = m.branch;
      }
    }

    const entry = {
      id: r.id,
      type: clamp(r.type, DETAIL_MAX),
      detail: clamp(r.detail, DETAIL_MAX),
      at: isoAt(r.at),
      status,
      done: status !== 'running',
      model: clamp(model || r.resModel || r.reqModel, NAME_MAX),
      harness: clamp(harness || r.pharness || '', DETAIL_MAX),
      repo: clamp(repo, DETAIL_MAX),
      branch: clamp(branch, NAME_MAX),
      tools,
      toolRunning,
      toolsAt,
    };
    if (status !== 'running') entry.doneAt = isoAt(doneAt);
    srcById.set(r.id, r.src || '');
    out.push(entry);
  }

  const when = e => Date.parse(e.done ? (e.doneAt || e.at) : e.at) || 0;
  const cmp = (x, y) => (x.done === y.done
    ? (when(y) - when(x)) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
    : (x.done ? 1 : -1));
  out.sort(cmp);
  const top = out.slice(0, SUB_MAX);
  for (const e of top) if (e.status === 'running') noteLiveSession(agentId, srcById.get(e.id), now);
  return top;
}

async function buildSnapshot(now, fleetMaxAge) {
  const f = await fleet(now, fleetMaxAge);
  const scan = probeTranscripts(now);
  const rows = [];
  const seen = new Set();
  if (f.ok) {
    for (const a of f.agents) {
      const id = a && typeof a.id === 'string' ? a.id : '';
      if (!NAME_BY_ID.has(id) || seen.has(id)) continue;
      seen.add(id);
      const status = STATUSES.has(a.status) ? a.status : 'idle';
      rows.push({ id, name: clamp(a.name || NAME_BY_ID.get(id)), status, lastTask: clamp(a.lastTask || '') });
    }
  }
  for (const a of AGENTS) {
    if (seen.has(a.id)) continue;
    const st = f.ok ? null : scan.best.get(a.id);
    const fresh = !!st && now - st.mtimeMs <= TRAIL_FRESH_MS;
    rows.push({ id: a.id, name: a.name, status: fresh ? 'active' : 'idle', lastTask: '' });
  }

  transcriptsOk = scan.ok;
  const stats = scan.best;
  const sessions = scan.sessions;

  const agents = rows.map(r => {
    const stat = stats.get(r.id);
    let subagents;
    try { subagents = subsFor(r.id, sessions.get(r.id), now); } catch { subagents = []; }
    if (r.status === 'idle') {
      return { id: r.id, name: r.name, status: 'idle', lastTask: r.lastTask, tools: [], kindsAt: {}, toolRunning: false, toolsAt: 0, subagents, project: null,
               model: '', harness: '', repo: '', branch: '' };
    }
    let t;
    try { t = trailFor(r.id, stat, now); } catch { t = EMPTY_TRAIL; }
    return {
      id: r.id, name: r.name, status: r.status, lastTask: r.lastTask,
      tools: t.tools, kindsAt: t.kindsAt || {}, toolRunning: t.toolRunning, toolsAt: t.toolsAt,
      subagents, project: t.project,
      model: (t.meta || EMPTY_META).model, harness: (t.meta || EMPTY_META).harness,
      repo: (t.meta || EMPTY_META).repo, branch: (t.meta || EMPTY_META).branch,
    };
  });

  return {
    ok: true,
    at: new Date(now).toISOString(),
    source: { console: f.ok, transcripts: transcriptsOk },
    agents,
  };
}

let snapMemo = { at: 0, val: null };
let snapPending = null;
function rememberSnap(v) {
  const cur = snapMemo.val;
  if (!cur || (Date.parse(v.at) || 0) >= (Date.parse(cur.at) || 0)) snapMemo = { at: Date.now(), val: v };
  return snapMemo.val;
}
function getSnapshot() {
  const now = Date.now();
  if (snapMemo.val && now - snapMemo.at < SNAPSHOT_MEMO_MS) return Promise.resolve(snapMemo.val);
  if (!snapPending) {
    snapPending = buildSnapshot(now).then(v => {
      const out = rememberSnap(v);
      snapPending = null;
      return out;
    }).catch(e => {
      snapPending = null;
      throw e;
    });
  }
  return snapPending;
}

const clients = new Set();
let tickers = null;
let lastSig = '';
let lastPushAtMs = 0;
let lastFrameMs = 0;

const sigOf = s => JSON.stringify({ source: s.source, agents: s.agents });

function writeFrame(snap) {
  const frame = 'data: ' + JSON.stringify(snap) + '\n\n';
  for (const res of clients) { try { res.write(frame); } catch { } }
  lastSig = sigOf(snap);
  lastPushAtMs = Date.parse(snap.at) || 0;
  lastFrameMs = Date.now();
}

function pushIfChanged(snap) {
  if (!clients.size) return;
  if (sigOf(snap) !== lastSig) return writeFrame(snap);
  if (Date.now() - lastFrameMs >= HEARTBEAT_MS) return writeFrame(snap);
}

async function tick(fleetMaxAge) {
  if (!clients.size) return;
  try {
    const snap = await buildSnapshot(Date.now(), fleetMaxAge);
    pushIfChanged(rememberSnap(snap));
  } catch { }
}

function startTickers() {
  if (tickers) return;
  tickers = {
    console: setInterval(() => { tick(0); }, 1000),
    stat: setInterval(() => { tick(1500); }, 500),
  };
}
function stopTickers() {
  if (!tickers) return;
  clearInterval(tickers.console);
  clearInterval(tickers.stat);
  tickers = null;
}

const JSON_HEAD = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; img-src 'self' data:; " +
  "connect-src 'self'; form-action 'none'";

function sendJson(req, res, obj, code = 200) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { ...JSON_HEAD, 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}
function sendText(req, res, code, text) {
  const body = Buffer.from(text);
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendText(req, res, 405, 'This view is read-only. Only GET is served.');
    }
    let pathname;
    try { pathname = new URL(req.url, 'http://' + HOST + ':' + PORT).pathname; } catch { pathname = ''; }

    if (pathname === '/' || pathname === '/index.html') {
      if (!fs.existsSync(PAGE)) return sendText(req, res, 500, 'index.html is missing next to server.js');
      let body;
      try { body = fs.readFileSync(PAGE); } catch { return sendText(req, res, 500, 'index.html could not be read'); }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': CSP,
        'Content-Length': body.length,
      });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }

    if (pathname === '/api/health') {
      transcriptsOk = probeTranscripts().ok;
      const f = await fleet(Date.now());
      return sendJson(req, res, {
        ok: true,
        port: PORT,
        console: f.ok,
        transcripts: transcriptsOk,
        clients: clients.size,
        noteScans,
        noteBytes,
        subParses,
        subParseFails,
        sidecarReads,
        time: new Date().toISOString(),
      });
    }

    if (pathname === '/api/agents') {
      const snap = await getSnapshot();
      return sendJson(req, res, snap);
    }

    if (pathname === '/api/stream') {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end();
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();

      const ka = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { } }, 15000);
      let gone = false;
      const bye = () => {
        if (gone) return;
        gone = true;
        clearInterval(ka);
        clients.delete(res);
        if (!clients.size) stopTickers();
        console.log('[agent-view] SSE disconnect, clients=' + clients.size);
      };
      req.on('close', bye);
      req.on('error', bye);
      res.on('close', bye);
      res.on('error', bye);

      let snap = null;
      try { await getSnapshot(); } catch { }
      snap = snapMemo.val;
      if (gone) return;
      if (snap) {
        try { res.write('data: ' + JSON.stringify(snap) + '\n\n'); } catch { }
        const ts = Date.parse(snap.at) || 0;
        if (ts >= lastPushAtMs) { lastSig = sigOf(snap); lastPushAtMs = ts; }
        if (!clients.size) lastFrameMs = Date.now();
      }
      clients.add(res);
      startTickers();
      console.log('[agent-view] SSE connect, clients=' + clients.size);
      return;
    }

    return sendText(req, res, 404, 'Not found');
  } catch (e) {
    try { sendText(req, res, 500, 'error'); } catch { }
  }
});

server.on('clientError', (err, socket) => { try { socket.destroy(); } catch { } });

server.listen(PORT, HOST, async () => {
  let consoleOk = false;
  try { consoleOk = (await fleet(Date.now(), 0)).ok; } catch { consoleOk = false; }
  console.log(`[agent-view] listening on http://${HOST}:${PORT} transcripts=${transcriptsOk} console=${consoleOk}`);
});
