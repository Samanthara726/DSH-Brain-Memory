// dsh-brain-memory —— 把「模拟人脑」记忆系统接给 DSH 自己用。
//
// 本体是 server/memory_service.py（标准库 HTTP 服务，零依赖）。v2.0 起遗忘用
// FSRS-5：每条记忆有自己的牢固度 S 和难度 D，
//     R = (1 + (19/81)·t/S)^-0.5     importance = base × R（地板 0.05）
// 重要度 ≥0.7 永不衰减，R 掉到冻结线以下就不再自动注入；召回是中文 2-gram
// 字面 + 本机向量语义两路 RRF 合并（向量服务可选，挂了自动退回纯 2-gram）。
// 插件这边只连 URL，不关心实现——所以从 v1 换到 v2 不需要动这个文件。
//
// DSH 用它自己的实例（127.0.0.1:8793 + ~/.dsh/brain-memory/memory.db），
// 跟聊天机器人那边的库互不污染：两套记忆不该混在一起。
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

/** 回合内只召回一次：同一条用户消息反复组装（多步/重试）不重复打服务。 */
function makeRecallCache() {
  let key = ''
  let block = ''
  return {
    /** @returns {Promise<string>} 0 = 无命中/失败。 */
    async recall(agent) {
      const query = lastUserText(agent).slice(0, QUERY_MAX_CHARS)
      if (!query) return ''
      const stamp = `${agent?.session?.id ?? ''}|${agent?.id ?? ''}|${query}`
      if (stamp === key) return block
      key = stamp
      block = ''
      try {
        const result = await api('/context', {
          body: { query, k: RECALL_K, max_chars: RECALL_MAX_CHARS },
          timeoutMs: RECALL_TIMEOUT_MS,
        })
        const text = typeof result?.block === 'string' ? result.block.trim() : ''
        // `{{` 会被 system-prompt 当变量引用插值，未知引用直接抛错 → 必须拆开
        block = text ? text.replaceAll('{{', '{ {') : ''
        if (block) log(`召回 ${result.count ?? '?'} 段（${result.chars ?? block.length} 字）`)
      } catch (error) {
        log(`召回失败：${error?.message ?? error}`)
        block = ''
      }
      return block
    },
  }
}

/**
 * @param {object} ctx - cordis 插件上下文（tools/systemPrompt 已注入）。
 */
export function apply(ctx) {
  const cache = makeRecallCache()

  // ① 每轮组装时追加召回块（异步瀑布，失败即原样返回）
  ctx.effect(() => ctx.on('system-prompt/assemble', async (assembly, context) => {
    try {
      if (!assembly || !Array.isArray(assembly.contexts)) return assembly
      const block = await cache.recall(context?.agent)
      if (block) assembly.contexts.push({ name: 'brain:memory', text: block })
    } catch (error) {
      log(`注入失败：${error?.message ?? error}`)
    }
    return assembly
  }), 'dsh-brain-memory: recall injection')

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
      log(`落库 ${text.length} 字（session=${sessionId}）`)
      api('/write', { body: { text, source: `dsh:${sessionId}` }, timeoutMs: WRITE_TIMEOUT_MS })
        .catch((error) => log(`落库失败：${error?.message ?? error}`))
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
      '「模拟人脑」记忆库（独立服务：遗忘曲线 + 性格权重，DSH 侧专用；QQ 里那条鱼用的是另一个库）。'
      + 'recall=按关键词查旧记忆（2-gram 匹配，返回命中原文与重要度）；'
      + 'write=手动记一条（importance 0.05~1，≥0.7 永不衰减，pin=true 直接钉住）；'
      + 'stats=库状态（总条数/受保护/快忘光的/平均重要度/上次衰减）。'
      + '本轮对话的召回是自动的（每轮按你最后一条消息捞 3 段），这里只用于主动翻旧的或手动钉一件事。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['recall', 'write', 'stats'],
          description: 'recall=查记忆；write=写记忆；stats=库状态',
        },
        query: { type: 'string', description: 'recall 的查询词（中文即可，短词更准）' },
        text: { type: 'string', description: 'write 要记的原文（一句话最好，别贴长文档）' },
        importance: { type: 'number', description: 'write 的重要度 0.05~1（缺省由服务按文本猜）' },
        personality: { type: 'number', description: 'write 的性格权重 0~1（跟用户自己/关系相关的给高些）' },
        pin: { type: 'boolean', description: 'write 时直接钉住（永不衰减）' },
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
          const result = await api('/recall', { body: { query, k }, timeoutMs: 2500 })
          const hits = Array.isArray(result?.hits) ? result.hits : []
          if (hits.length === 0) return { ok: true, message: `没翻到关于「${query}」的记忆` }
          const lines = hits.map((hit, index) => {
            const text = String(hit?.text ?? '').replace(/\s+/g, ' ').trim()
            return `${index + 1}. [重要度 ${Number(hit?.importance ?? 0).toFixed(2)}｜${Number(hit?.age_days ?? 0).toFixed(1)} 天前] ${text}`
          })
          return { ok: true, message: `翻到 ${hits.length} 条：\n${lines.join('\n')}` }
        }
        if (action === 'write') {
          const text = String(args?.text ?? '').trim()
          if (!text) return { ok: false, message: 'write 需要 text' }
          const body = { text: text.slice(0, WRITE_MAX_CHARS), source: 'dsh:manual' }
          if (Number.isFinite(Number(args?.importance))) body.importance = Number(args.importance)
          if (Number.isFinite(Number(args?.personality))) body.personality = Number(args.personality)
          if (args?.pin === true) body.pin = true
          const result = await api('/write', { body, timeoutMs: 2500 })
          if (result?.dedup) return { ok: true, message: `这条本来就在库里（id ${result.id}），没重复存` }
          return { ok: true, message: `记住了（id ${result?.id ?? '?'}）` }
        }
        if (action === 'stats') {
          const result = await api('/stats', { method: 'GET', timeoutMs: 2500 })
          return {
            ok: true,
            message: `记忆库 ${result?.total ?? 0} 条，受保护 ${result?.pinned ?? 0} 条，快忘光 ${result?.cold ?? 0} 条，`
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
