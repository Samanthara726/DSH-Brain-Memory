# dsh-brain-memory

给 DSH 接一套「模拟人脑」记忆：**FSRS-5 遗忘曲线 + 性格权重 + 中文 2-gram + 可选本地向量**。
记忆存在独立的 SQLite 库里（不是 DSH 自己的 session 存储），每轮对话自动召回 3 段塞进上下文，
回合结束自动把这一问一答落库；聊得越久，越像跟同一个老朋友说话。

> **v2.1**：记忆分成两层——**长期事实**（带 `why` 和 `factKey`，常驻注入）和**对话流水**
> （照常落库，但不进提示）。同一件事变了，用同一个 `factKey` 再写一条，旧条自动被取代、
> 不再出现，**但一条都不删**。老库启动时自动补列，接口向后兼容。
>
> **v2.0**：遗忘曲线从线性衰减换成 FSRS-5，召回加了一路本地向量（CPU，不占显存），
> 新增人物账本和只读 3D 面板。**插件本身（`lib/index.js`）一行没改**——服务接口向后兼容，
> 老库启动时自动迁移。

---

## 它到底做了什么

插件挂三条贡献：

- **注入**（`system-prompt/assemble` 瀑布）：每轮取一次「当前有效的长期事实」块（`/facts`，
  ≤`DSH_BRAIN_FACTS_CHARS` 字，服务端自带护栏模板）追加成动态上下文。只取带 `factKey`
  或钉住的条目——内容稳定，只在事实真的变了才变；
- **落库**（`agent/settled`）：回合结束把「最后一问 + 最后答」当**流水**写进库，
  `importance` 压到 0.15、不带键、不钉住。查得到，但不会进提示；
- **工具**（`brain_memory`）：`write` 记一条带 `why` / `factKey` 的事实、`recall` 翻旧账
  （`deep=true` 连被取代的旧说法一起）、`facts` 看当前注入块、`stats` 看库状态。

为什么注入不再按话题召回：召回块每轮都跟着话题变，等于每轮往系统提示里塞一段新东西，
会打断模型的前缀缓存（前缀一变，后面全要重算）。想按话题翻旧事，那是工具的活，让模型自己决定何时查。

三条底线：只加记忆、不动人格；召回超时 800ms 硬截断、失败就当没有；注入文本里的 `{{`
会被拆开，不会让 system-prompt 的变量插值炸掉整次组装。

---

## v2.0 相对 1.0 的改动

| | 1.0 | 2.0 |
| --- | --- | --- |
| 遗忘 | 线性衰减（每天固定减一点） | **FSRS-5**：每条记忆有自己的牢固度 S 和难度 D |
| 召回 | 只有中文 2-gram | 2-gram + **本地向量**两路 RRF 合并（向量可选） |
| 人物档案 | 无 | **账本**表：喜欢/不喜欢/事实/经历/约定（带到期） |
| 观察 | `/stats` 一行数字 | `/graph` + **只读 3D 星脑面板** |
| 库结构 | documents | + vectors + ledger + fsrs 字段（**老库自动迁移**） |

插件侧完全兼容：`lib/index.js`、`cordis.patch.yml`、`test/smoke.mjs` 都没动。

---

## 目录

```
lib/index.js               插件本体（cordis plugin）
cordis.patch.yml           一条 insert 贡献
package.json
server/memory_service.py   记忆服务（标准库，零依赖，Python 3.10+）
server/embed_service.py    向量服务（可选，torch + transformers，强制 CPU）
scripts/memory-nebula.mjs  星脑面板适配器（只读，Node 18+）
web/                       面板静态页 + vendor/three
docs/                      说明书 / 参数与调优 / FAQ
test/smoke.mjs             冒烟测试：假 ctx 跑一遍，验证三条贡献都接上了
test/selftest-memory-factkey.py  事实键 / 取代 / 软删自测（临时库，23 项）
```

---

## 安装插件

DSH 桌面版没有 `dsh plugin add`，手工装（和现有插件同一套流程）：

1. 把整个目录放进 `~/.dsh/plugins/dsh-brain-memory`
2. 在 profile 的 `package.json` 里加依赖与 bundle 条目：

   ```json
   "dependencies": { "dsh-brain-memory": "link:../../plugins/dsh-brain-memory" },
   "dsh": { "profile": { "bundles": ["dsh-brain-memory"] } }
   ```

3. 在 `~/.dsh/profiles/<profile>/node_modules` 下建同名的 junction；
4. 重启一次 DSH（或等它热加载），日志里出现 `dsh-brain-memory` 就通了。

---

## 起服务

```bash
python server/memory_service.py      # 默认 127.0.0.1:8790
```

> 接这个插件时把端口设成 **8793**（插件默认连这里）：
> `set MEM_PORT=8793`（PowerShell）或 `MEM_PORT=8793 python server/memory_service.py`
>
> 库位置也建议挪到 DSH 自己的目录，别跟别的实例混：
> `MEM_DB=%USERPROFILE%\.dsh\brain-memory\memory.db`

想要语义检索再加一个进程（可选，CPU 跑，不占显存）：

```bash
pip install torch transformers
huggingface-cli download BAAI/bge-base-zh-v1.5 --local-dir state/models/bge-base-zh-v1.5
python server/embed_service.py       # 8794
```

**向量服务挂了不影响任何事**：请求失败就退回纯 2-gram，只是少了语义那一路。

---

## 配置

插件侧：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_BRAIN_URL` | `http://127.0.0.1:8793` | 记忆服务地址 |
| `DSH_BRAIN_DIR` | `~/.dsh/brain-memory` | 插件日志目录（`plugin.log`） |
| `DSH_BRAIN_RECALL_TIMEOUT` | `800` | 召回超时（ms），超了就当没记忆 |
| `DSH_BRAIN_WRITE_TIMEOUT` | `2500` | 落库超时（ms），fire-and-forget |
| `DSH_BRAIN_FACTS_CHARS` | `1600` | 每轮注入的事实块字数上限；装不下就往后截 |

服务端：见 [`docs/参数与调优.md`](docs/参数与调优.md)（`MEM_DB` / `MEM_PORT` / `MEM_K` /
`MEM_INJECT_CAP` / `MEM_FREEZE_BELOW` / `MEM_EMBED_*` …）。

服务端接口：

```
GET  /health  /stats  /graph  /facts  /ledger/people
POST /write    {text, importance?, personality?, emotion?, source?, pin?, why?, fact_key?}
POST /recall   {query, k?, deep?}              手动翻旧账（deep=true 连被取代的旧说法一起翻）
POST /context  {query, k?, max_chars?}         按话题召回聊天片段（内容丰富，但每轮都变）
POST /facts    {max_chars?}                    当前有效的长期事实块（稳定，适合常驻注入）
POST /delete   {ids? | fact_key?}              软删（置 deleted=1，真身不删）
POST /decay    {force?}                        手动跑一次每日衰减
POST /reindex  {limit?}                        补向量（换模型后必跑）
POST /ledger/add | /ledger/list | /ledger/update | /ledger/digest | /ledger/due
```

---

## 从 1.0 升级

**直接换代码就行**，库会自动迁移：

1. 停掉旧服务，备份库（WAL 模式下别只拷 `.db`）：
   `sqlite3 ~/.dsh/brain-memory/memory.db ".backup memory.db.bak"`
2. 用 2.0 的 `server/memory_service.py` 覆盖旧的，起服务；
3. 日志里会有一行 `FSRS 迁移：补列 …；按 importance 反推初始 S/D 的记录 N 条`——
   旧的重要度原样保留，只是给每条补上 S/D；
4. 如果起了向量服务，跑一次 `curl -X POST 127.0.0.1:8793/reindex -d "{\"limit\":24}"`
   给老记忆补向量（分批，别一次要太多）；
5. 插件不用动，重启 DSH 即可。

`/stats` 里 `vectors` 追上 `total` 就说明向量补齐了。

---

## 面板（可选）

想看看库里长什么样：

```bash
MEM_BASE=http://127.0.0.1:8793 node scripts/memory-nebula.mjs --open    # 8643
```

每个点是一条记忆，亮度和大小对应重要度；四个区域：钉住的、跟她自己有关的、快忘光的、日常话题。
**只读**——写接口一律 403，面板不是编辑器。

---

## 测试

```bash
# 1) 事实键 / 取代 / 软删：全在临时库上跑，不碰真库（23 项）
python test/selftest-memory-factkey.py

# 2) 插件冒烟：先起服务指向临时库，别污染日常记忆
MEM_PORT=8794 MEM_DB=./tmp/db.sqlite MEM_LOG=./tmp/svc.log python server/memory_service.py
DSH_BRAIN_URL=http://127.0.0.1:8794 node test/smoke.mjs
```

预期：`selftest` 输出 23 行 `PASS`；`smoke` 输出几行 `[ok]` 加一行 `[ok] 全部通过`。

---

## 文档

- [说明书](docs/说明书.md)：原理、一条记忆的一生、为什么这么设计
- [参数与调优](docs/参数与调优.md)：所有环境变量 / 调优顺序 / 场景推荐值
- [FAQ](docs/FAQ.md)：排查与踩坑

## License

MIT © [Samanthara726](https://github.com/Samanthara726)。面板的视觉部分派生自
`dsh-memory-brain-plugin` 的 web 目录（同样 MIT），详见 [NOTICE](NOTICE)。
