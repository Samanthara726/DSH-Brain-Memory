# -*- coding: utf-8 -*-
"""记忆 factKey / 取代 / why 的自测：全在临时库里跑，绝不碰真库。

跑法：python test/selftest-memory-factkey.py（在仓库根目录跑）

验的是这几条：
  1. 首次写入能落库
  2. 同一 fact_key 写了新事实 → 旧条被打上 superseded_by，不是删掉
  3. 不同 fact_key 互不取代
  4. 默认召回不返回被取代的旧条，deep=True 才翻得出来
  5. why 和 fact_key 跟着召回一起出来，并进得了注入块
  6. factKey 的机械归一（全角点、空白、首尾点）
  7. 同文本重复写入走 dedup，不会多出一条
"""
import os
import sys
import tempfile

TMP = tempfile.mkdtemp(prefix="memfact-")os.environ["MEM_DB"] = os.path.join(TMP, "memory.db")
os.environ["MEM_EMBED_ENABLED"] = "0"
os.environ["MEM_LOG"] = os.path.join(TMP, "memory-service.log")

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
import memory_service as m  # noqa: E402

CHECKS = []


def check(name, cond, detail=""):
    CHECKS.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (("  | " + str(detail)) if detail else ""))


m.log = m.setup_logging()
m.init_db()

r1 = m.do_write({
    "text": "主人说十点睡，实际躺着刷视频",
    "fact_key": "约定.睡觉",
    "why": "第二天要早起，晚睡会赖床",
})
check("写入成功", r1.get("ok") and r1.get("id"), r1)
first = r1["id"]

r2 = m.do_write({
    "text": "睡觉口径改成十一点，可以看完一集再睡",
    "fact_key": "约定．睡觉",  # 故意用全角点，验证归一化后仍能取代
    "why": "主人自己改的口径，别再按十点催",
})
check("新条写入", r2.get("ok"), r2)
check("旧条被取代", r2.get("superseded") == [first], r2.get("superseded"))

r3 = m.do_write({
    "text": "主人不喜欢被催",
    "fact_key": "偏好.催促",
    "why": "催了会烦，宁可等他自己开口",
})
check("不同键不互相取代", r3.get("superseded") == [], r3.get("superseded"))

con = m.connect()
old = con.execute("SELECT superseded_by, text FROM documents WHERE id = ?", (first,)).fetchone()
check("旧条的标记真落库了", old and old["superseded_by"] == r2["id"], dict(old) if old else None)
check("旧条正文没被改写", old and "十点睡" in old["text"], old["text"] if old else None)
con.close()

QUERY = "睡觉 十点"  # 故意让新旧两条都能撞上，才好对比「默认排旧、deep 翻旧」
hits = m.score_rows(QUERY, 10, allow_frozen=True)
ids = [h["id"] for h in hits]
check("默认召回不含被取代的旧条", first not in ids, ids)
check("默认召回含新条", r2["id"] in ids, ids)

deep = m.score_rows(QUERY, 10, allow_frozen=True, include_superseded=True)
check("deep 能翻出旧条", first in [h["id"] for h in deep], [h["id"] for h in deep])
check("deep 把新条也带着", r2["id"] in [h["id"] for h in deep], [h["id"] for h in deep])

hit = next((h for h in hits if h["id"] == r2["id"]), None)
check("召回条目带 why", hit and "主人自己改" in (hit.get("why") or ""), hit.get("why") if hit else None)
check("召回条目带 fact_key", hit and hit.get("fact_key") == "约定.睡觉", hit.get("fact_key") if hit else None)

check("全角点归一", m.normalize_fact_key("约定．睡觉") == "约定.睡觉", m.normalize_fact_key("约定．睡觉"))
check("空白去掉", m.normalize_fact_key(" 约定 . 睡觉 ") == "约定.睡觉", m.normalize_fact_key(" 约定 . 睡觉 "))
check("首尾点去掉", m.normalize_fact_key(".约定.睡觉.") == "约定.睡觉", m.normalize_fact_key(".约定.睡觉."))

block = m.build_block(hits, 1200)
check("注入块里带上了 why", "为什么记着" in block, block[:100].replace("\n", " "))

r4 = m.do_write({"text": "主人不喜欢被催", "fact_key": "偏好.催促", "why": "补一句理由"})
check("同文本重复写入走 dedup", r4.get("dedup") is True, r4)

# 8. /facts：只吐「带 fact_key 的或钉住的」，流水不进去
plain = m.do_write({"text": "【自测】一条没键也没钉的流水", "importance": 0.3})
facts_block = (m.do_facts({"max_chars": 900}).get("block") or "")
check("/facts 含带键条目", "约定.睡觉" in facts_block, facts_block[:80])
check("/facts 不含无键流水", "没键也没钉" not in facts_block, facts_block[:80])
check("/facts 带上 why", "因为" in facts_block, facts_block[:80])

# 9. /delete：软删之后不再出现，但行还在（deleted=1）
dropped = m.do_delete({"ids": [plain["id"]]})
check("/delete 软删成功", dropped.get("ok") and dropped.get("changed") == 1, dropped)
after = m.do_facts({"max_chars": 900}).get("block") or ""
check("软删后 /facts 里没有了", "没键也没钉" not in after, after[:80])
con2 = m.connect()
row = con2.execute("SELECT deleted FROM documents WHERE id = ?", (plain["id"],)).fetchone()
con2.close()
check("软删只是打标记，行还在", row is not None and row["deleted"] == 1, dict(row) if row else None)

import gc  # noqa: E402
import shutil  # noqa: E402
import time  # noqa: E402

# 临时库要清掉：Windows 上 sqlite 连接没释放时删不动，gc 之后重试几次
gc.collect()
for _ in range(5):
    if not os.path.isdir(TMP):
        break
    shutil.rmtree(TMP, ignore_errors=True)
    time.sleep(0.2)
if os.path.isdir(TMP):
    print(f"（提示：临时目录没删掉，可以手动删 {TMP}）")

failed = [name for name, ok in CHECKS if not ok]
print("\n结果：%d/%d 通过" % (len(CHECKS) - len(failed), len(CHECKS)))
if failed:
    print("没过的：" + "、".join(failed))
sys.exit(1 if failed else 0)
