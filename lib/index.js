// dsh-brain-memory —— 把 QQ 那边那套「模拟人脑」记忆系统接给 DSH 自己用。
//
// 那套东西本体是 services/memory_service.py（标准库 HTTP 服务，带遗忘曲线：
// rate = 0.008 × fresh × salience × review × emotion × (1-0.6×性格权重)，
// 单日跌幅 ≤0.03、地板 0.05、importance≥0.7 永不衰减、被想起 +0.02）。
// 原来只有小鱼在用（127.0.0.1:8790 + 项目的 state/memory/memory.db）。
// 这里让 DSH 用自己的实例（127.0.0.1:8793 + ~/.dsh/brain-memory/memory.db），
// 两个库互不污染：她的聊天记忆不该混进我的会话记忆。
//
// 挂两条贡献：
//   ① system-prompt/assemble（瀑布，可 async）：每轮按最后一条用户消息召回，
//      命中就把服务返回的带护栏小块追加为动态运行时上下文。这一条**必须是
//      瀑布而不是 systemPrompt.context()**：后者的 text(context) 是同步求值的
//      （见 dsh-system-prompt 的 assemble()：`typeof entry.text === 'function'
//      ? entry.text(context)`，没有 await），在同步回调里发 HTTP 只能阻塞主线程。
//   ② agent/settled：回合结束把「最后一问 + 最后答」落库，服务端按 sha256 去重。
//
// 三条铁律（照抄实施单）：
//   · 只加记忆，不动人格：块由服务端带护栏模板，这里只搬运，绝不改角色卡。
//   · 召回失败/超时不许拖慢回合：800ms 硬超时，异常吞掉，返回原 assembly。
//   · 注入文本里不能出现 `{{`：system-prompt 会对上下文做变量插值，出现未知
//     引用会直接抛错、让整次组装失败。所以落进块之前先把 `{{` 拆开。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-brain-memory'
export const inject = ['tools', 'systemPrompt']

const BASE_URL = (process.env.DSH_BRAIN_URL || 'http://127.0.0.1:8793').replace(/\/+$/, '')
const DATA_DIR = process.env.DSH_BRAIN_DIR || path.join(os.homedir(), '.dsh', 'brain-memory')
const LOG_PATH = path.join(DATA_DIR, 'plugin.log')

const RECALL_K = 3
const RECALL_MAX_CHARS = 1200
const RECALL_TIMEOUT_MS = Number(process.env.DSH_BRAIN_RECALL_TIMEOUT || 800)
const WRITE_TIMEOUT_MS = Number(process.env.DSH_BRAIN_WRITE_TIMEOUT || 2500)
// 一条记忆最多存多长（服务端另有 4000 字上限，这里留余量）
const WRITE_MAX_CHARS = 1200
// 注入查询最多取多长（太长会被 2-gram 稀释）
const QUERY_MAX_CHARS = 400
// 每轮注入的「长期事实」块上限：短、稳、只在事实真变了才变（对前缀缓存友好）
// 900 字装不下身份/关系/项目这几组必备事实（实测 10 条就 1291 字），放到 1600。
// 再加就得回头精简旧条，而不是继续抬上限——注入块是要每轮都付钱的。
const FACTS_MAX_CHARS = Number(process.env.DSH_BRAIN_FACTS_CHARS || 1600)
// 自动落库的流水权重：压到很低，让它能查但不参与注入（fact_key 为空 + 不 pin）
const AUTO_LOG_IMPORTANCE = 0.15

function log(msg) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* 日志写不进去就算了，绝不影响回合 */
  }
}

/**
 * 调记忆服务。
 * @param {string} pathname - 接口路径（/context、/write、/stats）。
 * @param {object} [opts] - method/body/timeoutMs。
 * @returns {Promise<object>} 解析后的 JSON。
 */
async function api(pathname, { method = 'POST', body, timeoutMs = 1500 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(BASE_URL + pathname, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** 会话事件流（新老快照都给同一个入口）。 */
function sessionEvents(agent) {
  const session = agent?.session
  if (!session) return []
  if (typeof session.snapshotEvents === 'function') {
    try {
      return session.snapshotEvents() ?? []
    } catch {
      /* 落到下面的 events */
    }
  }
  return Array.isArray(session.events) ? session.events : []
}

/** 从一条消息事件里拼出纯文本（只要 text 块，图片/工具结果不参与召回）。 */
function eventText(event) {
  const content = event?.data?.content ?? event?.data?.message?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** 最后一条真人输入（source.kind === 'user'，排除注入/工具回灌）。 */
function lastUserText(agent) {
  const events = sessionEvents(agent)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    if (event?.data?.source?.kind !== 'user') continue
    const text = eventText(event)
    if (text) return text
  }
  return ''
}

/** 最后一条真人输入 + 它之后最后一条助手输出（落库用）。 */
function lastExchange(agent) {
  const events = sessionEvents(agent)
  let user = ''
  let userIndex = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    if (event?.data?.source?.kind !== 'user') continue
    const text = eventText(event)
    if (!text) continue
    user = text
    userIndex = index
    break
  }
  if (userIndex < 0) return { user: '', assistant: '' }
  let assistant = ''
  for (let index = events.length - 1; index > userIndex; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const text = eventText(event)
    if (text) {
      assistant = text
      break
    }
  }
  return { user, assistant }
}

/**
 * 取「当前有效的长期事实」块，用于每轮注入。
 *
 * 跟原来按关键词召回的做法不同：这里要的是**稳**。
 * 召回块每轮都跟着话题变，等于每轮往系统提示里塞一段新东西——既吵，
 * 又会打断 DeepSeek 的前缀缓存（上下文前缀一变，后面全要重算）。
 * 长期事实只在真的变了（新条取代旧条）时才变，代价才可控。
 * 想按话题翻旧事，那是工具 `brain_memory` 的活，让我自己决定何时查。
 *
 * @returns {Promise<string>} 空串 = 没有事实 / 服务没起 / 超时。
 */
async function fetchFacts() {
  try {
    const result = await api('/facts', {
      body: { max_chars: FACTS_MAX_CHARS },
      timeoutMs: RECALL_TIMEOUT_MS,
    })
    const text = typeof result?.block === 'string' ? result.block.trim() : ''
    // `{{` 会被 system-prompt 当变量引用插值，未知引用直接抛错 → 必须拆开
    const block = text ? text.replaceAll('{{', '{ {') : ''
    if (block) log(`注入事实 ${result.count ?? '?'} 条（${result.chars ?? block.length} 字）`)
    return block
  } catch (error) {
    log(`取事实失败：${error?.message ?? error}`)
    return ''
  }
}

/**
 * @param {object} ctx - cordis 插件上下文（tools/systemPrompt 已注入）。
 */
export function apply(ctx) {
  // ① 每轮组装时追加「当前有效事实」（异步瀑布，失败即原样返回）
  ctx.effect(() => ctx.on('system-prompt/assemble', async (assembly, context) => {
    try {
      if (!assembly || !Array.isArray(assembly.contexts)) return assembly
      const block = await fetchFacts()
      if (block) assembly.contexts.push({ name: 'brain:facts', text: block })
    } catch (error) {
      log(`注入失败：${error?.message ?? error}`)
    }
    return assembly
  }), 'dsh-brain-memory: facts injection')

  // ② 回合收尾落库（子代理的回合不写，避免把子任务碎话混进来）
  ctx.effect(() => ctx.on('agent/settled', (agent, _turn, reason) => {
    try {
      const header = agent?.session?.header
      if (!header || header.origin === 'subagent') return
      if (reason?.kind && reason.kind !== 'completed') {
        log(`跳过落库：reason=${reason.kind}`)
        return
      }
      const { user, assistant } = lastExchange(agent)
      if (!user) {
        log(`跳过落库：没找到 user/message（events=${sessionEvents(agent).length}）`)
        return
      }
      const text = [user && `主人：${user}`, assistant && `我：${assistant}`]
        .filter(Boolean)
        .join('\n')
        .slice(0, WRITE_MAX_CHARS)
      if (text.length < 8) return
      const sessionId = agent?.session?.id ?? ''
      log(`落库流水 ${text.length} 字（session=${sessionId}）`)
      // 流水：低权重、无 fact_key、不 pin —— 留在库里有据可查，但不会进注入块
      api('/write', {
        body: { text, source: `dsh:${sessionId}`, importance: AUTO_LOG_IMPORTANCE },
        timeoutMs: WRITE_TIMEOUT_MS,
      }).catch((error) => log(`落库失败：${error?.message ?? error}`))
    } catch (error) {
      log(`落库处理失败：${error?.message ?? error}`)
    }
  }), 'dsh-brain-memory: write on settle')

  // ③ 自动召回之外的显式入口（查老记忆、手动记一条、看库状态）
  ctx.effect(() => ctx.tools.register(buildTool()), 'dsh-brain-memory: brain tool')
}

function buildTool() {
  return {
    name: 'brain_memory',
    description:
      '长期记忆库（DSH 侧专用，跟 QQ 小鱼那个库分开）。'
      + 'write=记一条会长期管用的事实，**要写 why（为什么值得记）**；同一件事变了就带同一个 factKey 再写一条，旧条会被自动标成已取代、不再进注入，但一条都不删；'
      + 'recall=按关键词翻旧账（deep=true 连被取代的旧说法一起翻出来）；'
      + 'facts=看现在每轮自动注入的那块长期事实长什么样；'
      + 'stats=库状态（条数/带 why/带 factKey/被取代）。'
      + '注意：每轮自动注入的只有「带 factKey 或钉住的」条目，聊天流水不会进去。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['recall', 'write', 'facts', 'stats'],
          description: 'write=记一条；recall=翻旧账；facts=看注入块；stats=库状态',
        },
        query: { type: 'string', description: 'recall 的查询词（中文即可，短词更准）' },
        text: { type: 'string', description: 'write 要记什么：一句话说清，后面可跟具体发生了什么' },
        why: { type: 'string', description: 'write 的关键：为什么值得记，写成「未来的我需要知道什么」；别写「因为重要」这种空话' },
        factKey: { type: 'string', description: 'write 的事实键「对象.方面」，如「主人.睡觉时间」「项目.记忆主库」；键里不写具体值。同键再写会取代旧的' },
        importance: { type: 'number', description: 'write 的重要度 0.05~1（缺省由服务按文本猜）' },
        personality: { type: 'number', description: 'write 的性格权重 0~1（跟用户自己/关系相关的给高些）' },
        pin: { type: 'boolean', description: 'write 时直接钉住（永不衰减，且一定进注入块）' },
        deep: { type: 'boolean', description: 'recall 时是否连被取代的旧说法一起翻出来' },
        k: { type: 'integer', description: 'recall 返回条数（1~10，缺省 5）' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
        },
        required: ['ok', 'message'],
      },
      render: (_args, value) => [{ type: 'text', text: value?.message ?? '' }],
    },
    async execute(args) {
      const action = String(args?.action ?? '')
      try {
        if (action === 'recall') {
          const query = String(args?.query ?? '').trim()
          if (!query) return { ok: false, message: 'recall 需要 query' }
          const k = Math.max(1, Math.min(10, Number(args?.k) || 5))
          const deep = args?.deep === true
          const result = await api('/recall', { body: { query, k, deep }, timeoutMs: 2500 })
          const hits = Array.isArray(result?.hits) ? result.hits : []
          if (hits.length === 0) return { ok: true, message: `没翻到关于「${query}」的记忆` }
          const lines = hits.map((hit, index) => {
            const text = String(hit?.text ?? '').replace(/\s+/g, ' ').trim()
            const key = String(hit?.fact_key ?? '').trim()
            const why = String(hit?.why ?? '').replace(/\s+/g, ' ').trim()
            const meta = [Number(hit?.importance ?? 0).toFixed(2), `${Number(hit?.age_days ?? 0).toFixed(1)} 天前`]
            if (key) meta.push(key)
            return `${index + 1}. [${meta.join('｜')}] ${text}` + (why ? `（为什么记着：${why}）` : '')
          })
          return {
            ok: true,
            message: `翻到 ${hits.length} 条${deep ? '（含被取代的旧说法）' : ''}：\n${lines.join('\n')}`,
          }
        }
        if (action === 'write') {
          const text = String(args?.text ?? '').trim()
          if (!text) return { ok: false, message: 'write 需要 text' }
          const why = String(args?.why ?? '').trim()
          const factKey = String(args?.factKey ?? args?.fact_key ?? '').trim()
          const body = { text: text.slice(0, WRITE_MAX_CHARS), source: 'dsh:manual' }
          if (why) body.why = why
          if (factKey) body.fact_key = factKey
          if (Number.isFinite(Number(args?.importance))) body.importance = Number(args.importance)
          if (Number.isFinite(Number(args?.personality))) body.personality = Number(args.personality)
          if (args?.pin === true) body.pin = true
          const result = await api('/write', { body, timeoutMs: 2500 })
          if (result?.dedup) return { ok: true, message: `这条本来就在库里（id ${result.id}），没重复存` }
          const superseded = Array.isArray(result?.superseded) ? result.superseded : []
          const notes = []
          if (superseded.length) notes.push(`取代了旧的 ${superseded.join('、')} 号（旧条留档，不再注入）`)
          if (!factKey) notes.push('没给 factKey → 这条不进每轮注入，只能 recall 翻到')
          if (!why) notes.push('没写 why → 下次翻到只知道发生了什么，不知道为什么')
          return {
            ok: true,
            message: `记住了（id ${result?.id ?? '?'}）` + (notes.length ? `。${notes.join('；')}` : ''),
          }
        }
        if (action === 'facts') {
          const result = await api('/facts', { body: { max_chars: FACTS_MAX_CHARS }, timeoutMs: 2500 })
          const block = String(result?.block ?? '').trim()
          return { ok: true, message: block || '现在没有任何长期事实（带 factKey 或钉住的）会进注入。' }
        }
        if (action === 'stats') {
          const result = await api('/stats', { method: 'GET', timeoutMs: 2500 })
          return {
            ok: true,
            message: `记忆库 ${result?.total ?? 0} 条（带 factKey ${result?.with_fact_key ?? 0}、带 why ${result?.with_why ?? 0}、已被取代 ${result?.superseded ?? 0}），`
              + `受保护 ${result?.pinned ?? 0}，快忘光 ${result?.cold ?? 0}，`
              + `平均重要度 ${Number(result?.avg_importance ?? 0).toFixed(3)}，上次衰减 ${result?.last_decay ?? '还没跑过'}`,
          }
        }
        return { ok: false, message: `不认识的 action：${action}` }
      } catch (error) {
        return { ok: false, message: `记忆服务出错：${error?.message ?? error}` }
      }
    },
  }
}
