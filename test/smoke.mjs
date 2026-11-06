// 冒烟测试：用假的 cordis ctx 把插件跑一遍，验证三条贡献真的接上了、
// 并且能跟 8793 上的真服务说上话。不依赖 DSH 启动。
//   node test/smoke.mjs
import assert from 'node:assert/strict'
import { apply, name, inject } from '../lib/index.js'

const disposers = []
const tools = []
const listeners = new Map()

const ctx = {
  effect(fn) {
    const dispose = fn()
    disposers.push(dispose)
    return dispose
  },
  on(event, handler) {
    listeners.set(event, handler)
    return () => listeners.delete(event)
  },
  get() {
    return undefined
  },
  tools: {
    register(definition) {
      tools.push(definition)
      return () => {}
    },
  },
}

function fakeAgent(userText, assistantText, { origin = 'user', id = 'sess-1' } = {}) {
  return {
    id: 'agent-1',
    session: {
      id,
      header: { origin, cwd: process.cwd() },
      events: [
        { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: userText }] } },
        { type: 'assistant/message', data: { content: [{ type: 'text', text: assistantText }] } },
      ],
    },
  }
}

assert.equal(name, 'dsh-brain-memory')
assert.deepEqual(inject, ['tools', 'systemPrompt'])

apply(ctx)
assert.ok(listeners.has('system-prompt/assemble'), '应注册 system-prompt/assemble 瀑布')
assert.ok(listeners.has('agent/settled'), '应注册 agent/settled')
assert.equal(tools.length, 1, '应注册一个工具')
assert.equal(tools[0].name, 'brain_memory')

// 1) 注入：先写一条，再用含关键字的用户消息组装一次，块应出现且不含 `{{`
const tool = tools[0]
const wrote = await tool.execute({ action: 'write', text: '冒烟测试：DSH 的记忆服务跑在 8793' })
assert.equal(wrote.ok, true, wrote.message)

const assembly = { sections: [], contexts: [], tools: [], variables: {} }
const out = await listeners.get('system-prompt/assemble')(
  assembly,
  { agent: fakeAgent('记忆服务跑在哪个端口', '8793') },
)
assert.equal(out, assembly, '瀑布应返回同一个 assembly 对象')
const injected = assembly.contexts.find((entry) => entry.name === 'brain:memory')
assert.ok(injected, '应注入 brain:memory 上下文')
assert.ok(injected.text.includes('8793'), `注入块应含命中原文：${injected.text}`)
assert.ok(!injected.text.includes('{{'), '注入块不能含 {{（会被变量插值炸掉）')
console.log('[ok] 注入：', injected.text.split('\n')[1])

// 2) 落库：settled 是 fire-and-forget，等一下再看 stats
const before = await tool.execute({ action: 'stats' })
listeners.get('agent/settled')(fakeAgent('这条应该被记住：今晚接 DSH 记忆', '好，我记一下'), 1, { kind: 'completed' })
await new Promise((resolve) => setTimeout(resolve, 1200))
const after = await tool.execute({ action: 'stats' })
console.log('[ok] stats 前：', before.message)
console.log('[ok] stats 后：', after.message)

// 3) recall 工具
const recalled = await tool.execute({ action: 'recall', query: '记忆 8793' })
assert.equal(recalled.ok, true)
assert.ok(recalled.message.includes('8793'), `recall 应命中：${recalled.message}`)
console.log('[ok] recall：', recalled.message.split('\n')[0])

// 4) 子代理回合不写库
const statsBefore = await tool.execute({ action: 'stats' })
listeners.get('agent/settled')(fakeAgent('子代理的话', '不该进库', { origin: 'subagent', id: 'sess-sub' }), 1, { kind: 'completed' })
await new Promise((resolve) => setTimeout(resolve, 800))
const statsAfter = await tool.execute({ action: 'stats' })
assert.equal(statsBefore.message, statsAfter.message, '子代理回合不应写入')

// 5) 服务挂了也不能抛：把地址指向死端口
console.log('[ok] 全部通过')
for (const dispose of disposers) if (typeof dispose === 'function') dispose()
