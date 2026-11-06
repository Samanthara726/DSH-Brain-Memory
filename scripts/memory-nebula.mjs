#!/usr/bin/env node
// 记忆星脑：把记忆库画成一张 3D 神经元图（只读）。
//
// 数据来源：记忆服务的 GET /graph（也就是 services/memory_service.py 那本库）。
// 面板只读：不写入、不改衰减、不碰数据库文件。
//
// 用法：
//   node scripts/memory-nebula.mjs            # 起本机页面 http://127.0.0.1:8643
//   node scripts/memory-nebula.mjs --open      # 起完顺手用浏览器打开
//
// 环境变量：
//   MEM_BASE      记忆服务地址（默认 http://127.0.0.1:8790）
//   NEBULA_PORT   面板端口（默认 8643）
//   NEBULA_DATA   侧车数据目录（默认 ./data：存主题和召回轨迹，不存原文）
//
// 与早期版本的区别：旧的做法是整页 15 秒重载一次（看内容根本来不及），
// 这个是单页一次性加载 + 手动「⟳ 重新拉取」，不会自己刷新。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'web');
const DATA_DIR = process.env.NEBULA_DATA || path.join(ROOT, 'data');
const NEB_FILE = path.join(DATA_DIR, 'nebula.json');
// 数据源：记忆服务的只读 /graph。面板自己不直接开库——WAL 模式下多一个句柄没好处。
const MEMORY_BASE = (process.env.MEM_BASE || 'http://127.0.0.1:8790').replace(/\/+$/, '');
const PORT = Number(process.env.NEBULA_PORT || 8643);
const BIND = '127.0.0.1';
const GRAPH_TTL_MS = 3000;

// 我们这边的记忆没有 8 个语义分区，就把面板的 8 个集群收成 5 个真用得上的：
// 钉住的（准则）、事实、跟她自己有关的（灵魂）、补记/复盘、日常聊过的（话题）。
const REGIONS = [
  { key: 'cortex', label: '大脑中枢', sub: '钉住的记忆', color: '#7d9dff', level: 'rules', immune: true },
  { key: 'hippo',  label: '海马体',   sub: '事实信息',   color: '#b48cff', level: 'fact',  immune: false },
  { key: 'soul',   label: '用户灵魂', sub: '跟她自己有关', color: '#ff77a9', level: 'user',  immune: false },
  { key: 'review', label: '论衡',     sub: '补记与复盘', color: '#ff9a6c', level: 'lesson', immune: false },
  { key: 'topics', label: '语言中枢', sub: '聊过的日子', color: '#57d8c9', level: 'topic', immune: false },
];
const HALF_BASE_DAYS = 3;

function log(msg) { console.log(`[nebula] ${msg}`); }

function pickRegion(node) {
  if (Number(node.pinned) > 0) return 'cortex';
  if (String(node.source || '').startsWith('backfill')) return 'review';
  if (Number(node.personality) >= 0.5) return 'soul';
  if (Number(node.importance) >= 0.85) return 'hippo';
  return 'topics';
}

function firstLine(text, max = 34) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max) + '…' : line;
}

/** 把我们的 documents 行映射成面板认识的 node 形状。 */
function toNode(row, now) {
  const importance = Math.max(0.05, Math.min(1, Number(row.importance) || 0.5));
  const ageDays = Math.max(0, Number(row.days) || 0);
  const region = pickRegion(row);
  const createdAt = Math.round(now - ageDays * 86400000);
  const title = firstLine(row.text);
  return {
    id: `doc-${row.id}`,
    kind: 'memory',
    level: (REGIONS.find((r) => r.key === region) || REGIONS[4]).level,
    region,
    title,
    content: String(row.text ?? ''),
    // 库里存的 grams 是中文 2-gram，混着数字/英文碎片；只留两个汉字的，
    // 面板上的关键词才不至于变成「08 / 35 / qw」这种噪音。
    keywords: String(row.grams ?? '').split(' ').filter((g) => /^[\u4e00-\u9fa5]{2}$/.test(g)).slice(0, 14),
    importance,
    status: 'active',
    project: String(row.source || ''),
    subcategory: '',
    goal: '',
    corrected: false,
    hit_count: Number(row.access) || 0,
    created_at: createdAt,
    updated_at: createdAt,
    last_accessed_at: null,
    source_session: String(row.source || ''),
    // 面板用 strength 决定亮度和大小、decay 决定「快忘掉了」的暗淡程度：
    // 我们的 importance 本身就是浮在 0.05 地板之上的数值，直接拿来当强度。
    strength: importance,
    decay: Math.round((1 - importance) * 1000) / 1000,
    immune: Number(row.pinned) > 0 || region === 'cortex',
    active: false,
    label: title,
  };
}

async function fetchOurGraph() {
  const res = await fetch(`${MEMORY_BASE}/graph`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`记忆服务 /graph 返回 ${res.status}（${MEMORY_BASE} 起了吗？）`);
  const payload = await res.json();
  if (!payload?.ok || !Array.isArray(payload.nodes)) {
    throw new Error(`拿不到记忆图谱：${JSON.stringify(payload).slice(0, 200)}`);
  }
  return payload;
}

let graphCache = { at: 0, data: null };
async function buildGraph({ force = false } = {}) {
  const now = Date.now();
  if (!force && graphCache.data && now - graphCache.at < GRAPH_TTL_MS) return graphCache.data;
  const raw = await fetchOurGraph();
  const rows = Array.isArray(raw.nodes) ? raw.nodes : [];
  const nodes = rows.map((row) => toNode(row, now));
  nodes.sort((a, b) => b.updated_at - a.updated_at);
  // 每条记忆挂到自己分区的锚点上（面板的「归属」细线），再加少量相似连线当神经丝。
  const links = nodes.map((n) => ({ a: n.id, b: `@${n.region}`, type: 'belong' }));
  const byRegion = {};
  for (const n of nodes) (byRegion[n.region] = byRegion[n.region] || []).push(n);
  for (const list of Object.values(byRegion)) {
    // 同一分区里按 2-gram 最多的相邻几条串一下，避免整张图只有星芒没有网。
    const grams = list.map((n) => new Set(n.keywords));
    for (let i = 0; i < list.length; i += 1) {
      let best = -1, bestScore = 0;
      for (let j = Math.max(0, i - 6); j < Math.min(list.length, i + 7); j += 1) {
        if (i === j) continue;
        const [small, big] = grams[i].size <= grams[j].size ? [grams[i], grams[j]] : [grams[j], grams[i]];
        let inter = 0;
        for (const g of small) if (big.has(g)) inter += 1;
        const score = inter / Math.max(1, small.size);
        if (score > bestScore && score >= 0.16) { bestScore = score; best = j; }
      }
      if (best >= 0) links.push({ a: list[i].id, b: list[best].id, type: 'proj' });
    }
  }
  const data = {
    // 只下发真的有东西的分区：空分区在面板上只是一个孤零零的锚点，白占地方。
    regions: REGIONS.filter((r) => nodes.some((n) => n.region === r.key)),
    nodes,
    links,
    halfLifeBaseDays: HALF_BASE_DAYS
  };
  graphCache = { at: now, data };
  return data;
}

// ── 实时脑图事件（「谁刚被想起来，谁亮一下」）──────────────────────────────
// 记忆服务在 /context 命中时会记一次 access_count，所以这里不用改服务：适配层
// 自己比对两次快照的召回次数，谁的数字涨了就发一条事件，面板沿着这个节点的
// 连线打光。事件只存 id 和数字，原文一个字节都不落盘。
const TRACE_FILE = path.join(DATA_DIR, 'nebula-trace.jsonl');
let accessSeen = null;
const eventQueue = [];
let lastEventPoll = 0;

function diffAccess(nodes, now) {
  if (!accessSeen) {
    // 第一次见到图：只记基线，不放闪光（否则一开页面就整张图乱闪）。
    accessSeen = new Map(nodes.map((n) => [n.id, n.hit_count]));
    return;
  }
  for (const n of nodes) {
    const prev = accessSeen.get(n.id);
    if (prev === undefined) {
      eventQueue.push({ ref: n.id, kind: 'remember', region: n.region, n: 1, at: now });
      accessSeen.set(n.id, n.hit_count);
      continue;
    }
    if (n.hit_count > prev) {
      eventQueue.push({ ref: n.id, kind: 'recall', region: n.region, n: n.hit_count - prev, at: now });
      accessSeen.set(n.id, n.hit_count);
    }
  }
  if (eventQueue.length > 200) eventQueue.splice(0, eventQueue.length - 200);
}

function appendTrace(events) {
  if (!events.length) return;
  try {
    fs.mkdirSync(path.dirname(TRACE_FILE), { recursive: true });
    // 轨迹只留最近一层历史：超过 8MB 就整份换成 .1，别让它无限长。
    try {
      if (fs.statSync(TRACE_FILE).size > 8 * 1024 * 1024) fs.renameSync(TRACE_FILE, `${TRACE_FILE}.1`);
    } catch { /* 还没有文件 */ }
    const lines = events.map((e) => JSON.stringify({ t: e.at, kind: e.kind, ref: e.ref, region: e.region, n: e.n })).join('\n') + '\n';
    fs.appendFileSync(TRACE_FILE, lines, 'utf8');
  } catch (error) {
    log(`写脑图轨迹失败：${error?.message ?? error}`);
  }
}

function buildStats(g) {  const byRegion = {}, byStatus = {}, proj = {}, kw = {}, recent = {};
  let sum = 0, faded = 0;
  for (const n of g.nodes) {
    byRegion[n.region] = (byRegion[n.region] || 0) + 1;
    byStatus[n.status] = (byStatus[n.status] || 0) + 1;
    sum += n.strength;
    if (n.status === 'active' && n.decay > 0.7) faded += 1;
    const src = String(n.project || '').trim();
    if (src) proj[src] = (proj[src] || 0) + 1;
    for (const k of n.keywords.slice(0, 13)) kw[String(k)] = (kw[String(k)] || 0) + 1;
    const day = new Date(n.updated_at || n.created_at).toLocaleDateString('sv');
    recent[day] = (recent[day] || 0) + 1;
  }
  const activity = [];
  for (let i = 13; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 86400000).toLocaleDateString('sv');
    activity.push({ day: d, count: recent[d] || 0 });
  }
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  return {
    total: g.nodes.length, memories: g.nodes.length, plugins: 0, skills: 0, steps: 0,
    by_region: byRegion, by_status: byStatus,
    plugin_states: { green: 0, yellow: 0, red: 0 },
    skill_states: { mastered: 0, learning: 0, optimize: 0 },
    avg_strength: g.nodes.length ? Math.round((sum / g.nodes.length) * 1e4) / 1e4 : 0,
    faded_active: faded,
    top_projects: top(proj, 10), top_keywords: top(kw, 14), activity,
    db_path: `记忆服务 ${MEMORY_BASE}（只读 /graph）`
  };
}

function searchNodes(g, { q = '', region = '', status = '', limit = 400 }) {
  const like = String(q || '').toLowerCase();
  const wantRegions = region ? new Set(region.split(',').map((s) => s.trim())) : null;
  const out = g.nodes.filter((n) => {
    if (wantRegions && !wantRegions.has(n.region)) return false;
    if (status && n.status !== status) return false;
    if (like && !(`${n.title} ${n.content} ${n.keywords.join(' ')} ${n.project}`.toLowerCase().includes(like))) return false;
    return true;
  });
  return { items: out.slice(0, Math.max(1, Math.min(Number(limit) || 400, 800))), total: out.length };
}

function readNebula() {
  try { return JSON.parse(fs.readFileSync(NEB_FILE, 'utf8')); } catch { return {}; }
}
function patchNebula(patch) {
  const cur = readNebula();
  const next = { ...cur, ...(patch && typeof patch === 'object' ? patch : {}) };
  try {
    fs.mkdirSync(path.dirname(NEB_FILE), { recursive: true });
    fs.writeFileSync(NEB_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch (error) {
    log(`写 nebula 侧车失败：${error?.message ?? error}`);
  }
  return next;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

async function handleApi(req, res, url) {
  const p = url.pathname.replace(/^\/api/, '/api');
  const q = Object.fromEntries(url.searchParams.entries());
  if (req.method === 'GET') {
    if (p === '/api/health') {
      return sendJson(res, 200, { ok: true, db: MEMORY_BASE, empty: false, tables: ['documents'], v: 2 });
    }
    if (p === '/api/graph') return sendJson(res, 200, await buildGraph());
    if (p === '/api/memories') return sendJson(res, 200, searchNodes(await buildGraph(), q));
    if (p === '/api/stats') return sendJson(res, 200, buildStats(await buildGraph()));
    if (p === '/api/memory') {
      const g = await buildGraph();
      const hit = g.nodes.find((n) => n.id === q.id || n.id === `doc-${q.id}`);
      return hit ? sendJson(res, 200, hit) : sendJson(res, 404, { ok: false, error: 'not found' });
    }
    if (p === '/api/nebula') return sendJson(res, 200, readNebula());
    if (p === '/api/events') {
      // 面板每 2 秒来问一次：顺手拉一份新快照（本机 sqlite，很便宜），比对谁又被想起了。
      const nowMs = Date.now();
      if (nowMs - lastEventPoll >= 1000) {
        lastEventPoll = nowMs;
        const fresh = await buildGraph({ force: true });
        diffAccess(fresh.nodes, nowMs);
      }
      const events = eventQueue.splice(0, eventQueue.length);
      appendTrace(events);
      return sendJson(res, 200, { ok: true, events });
    }
    if (p === '/api/ext-url') {
      const url = `http://${BIND}:${PORT}/`;
      // 面板的「在新标签打开」要用 origin（不带结尾斜杠）。
      return sendJson(res, 200, { ok: true, url, origin: url.replace(/\/$/, '') });
    }
    if (p === '/api/bus') {
      const g = await buildGraph();
      const cortex = g.nodes.filter((n) => n.region === 'cortex').slice(0, 20);
      const soul = g.nodes.filter((n) => n.region === 'soul').slice(0, 20);
      return sendJson(res, 200, {
        ok: true,
        version: 1,
        snapshot: { version: 1, cortex, soul },
        plugins: [],
        note: '只读：这里显示的是这条记忆库里钉住的和跟她自己有关的条目'
      });
    }
    if (p === '/api/wallpaper-frame') return sendJson(res, 404, { ok: false, error: '不支持壁纸帧（只读面板）' });
    return sendJson(res, 404, { ok: false, error: `没有这个接口：${p}` });
  }
  if (req.method === 'POST') {
    const body = await readBody(req);
    if (p === '/api/nebula') return sendJson(res, 200, { ok: true, data: patchNebula(body) });
    // 只读：召回计数那条 touch 当无事发生，编辑/删除/插件操作一律明确拒绝。
    if (p === '/api/memory/touch') return sendJson(res, 200, { ok: true });
    if (p === '/api/memory' || p === '/api/memory/update' || p === '/api/memory/delete') {
      return sendJson(res, 403, { ok: false, error: '只读面板：要改记忆请让她走原来的 memory 工具' });
    }
    if (p === '/api/plugin/action' || p === '/api/bus/push' || p === '/api/bus/resolve') {
      return sendJson(res, 403, { ok: false, error: '只读面板：这个星脑不管插件和人设总线' });
    }
    return sendJson(res, 404, { ok: false, error: `没有这个接口：${p}` });
  }
  return sendJson(res, 405, { ok: false, error: 'method not allowed' });
}

function serveStatic(req, res, url) {
  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.join(WEB_DIR, rel.replace(/^\/+/, ''));
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (error, buf) => {
    if (error) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${BIND}:${PORT}`);
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);
  handleApi(req, res, url).catch((error) => {
    log(`接口出错 ${url.pathname}：${error?.message ?? error}`);
    try { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }); } catch { /* 已断开 */ }
  });
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    log(`端口 ${PORT} 已被占用：星脑可能已经在跑了，直接开 http://${BIND}:${PORT}/`);
  } else {
    log(`起不来：${error?.message ?? error}`);
  }
  process.exit(1);
});

server.listen(PORT, BIND, () => {
  const url = `http://${BIND}:${PORT}/`;
  log(`记忆星脑已就绪：${url}（只读，数据源 ${MEMORY_BASE}/graph）`);
  if (process.argv.includes('--open')) execFile('cmd', ['/c', 'start', '', url], () => {});
});
