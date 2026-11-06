#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地向量编码小服务（CPU，不占显存）：给记忆检索算语义向量。

为什么单独一个进程：
  · 记忆服务刻意只依赖 Python 标准库（装不上 torch 的机器也能跑）；
  · 这个服务跑在有 torch + transformers 的环境里，**故意用 CPU**，不碰显卡——
    同一台机器上的生图 / 换声随时要用显存；
  · 挂了也不影响记忆：memory_service 请求失败就退回纯 2-gram 检索，不报错。

接口（只监听回环）：
    GET  /health                        -> {ok, model, dim, loaded}
    POST /embed {"texts": [...], "kind": "query"|"doc"}  -> {ok, dim, model, vectors: [[float...]]}

模型：默认 BAAI/bge-base-zh-v1.5（768 维，约 390MB）。用 EMBED_MODEL_DIR 可以指到
      bge-small-zh-v1.5（约 90MB、更快但分得没那么细）。模型全部读本地文件，不联网。
"""

import json
import logging
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

HOST = os.environ.get("EMBED_HOST", "127.0.0.1")
PORT = int(os.environ.get("EMBED_PORT", "8794"))
MODEL_DIR = os.environ.get("EMBED_MODEL_DIR") or os.path.join(ROOT, "state", "models", "bge-base-zh-v1.5")
LOG_PATH = os.environ.get("EMBED_LOG") or os.path.join(ROOT, "state", "memory", "embed-service.log")
THREADS = int(os.environ.get("EMBED_THREADS", "4"))
MAX_TEXTS = int(os.environ.get("EMBED_MAX_TEXTS", "64"))
MAX_TOKENS = int(os.environ.get("EMBED_MAX_TOKENS", "256"))
# bge 系列检索时建议给 query 加指令前缀，短查询命中率明显好一些。
QUERY_PREFIX = os.environ.get("EMBED_QUERY_PREFIX", "为这个句子生成表示以用于检索相关文章：")

log = None
_model = None
_tokenizer = None
_dim = 0
_lock = threading.Lock()


def setup_logging():
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.FileHandler(LOG_PATH, encoding="utf-8")],
    )
    return logging.getLogger("embed")


def load_model():
    global _model, _tokenizer, _dim
    if _model is not None:
        return
    import torch
    from transformers import AutoModel, AutoTokenizer

    torch.set_num_threads(max(1, THREADS))
    started = time.time()
    _tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR)
    _model = AutoModel.from_pretrained(MODEL_DIR)
    _model.eval()
    _dim = int(_model.config.hidden_size)
    log.info("模型就绪 %s dim=%s 用时 %.1fs（CPU，%d 线程）", MODEL_DIR, _dim, time.time() - started, THREADS)


def encode(texts, kind="doc"):
    """返回 L2 归一化后的向量列表（纯 list[float]，方便直接 JSON 出去）。"""
    import torch
    import torch.nn.functional as F

    load_model()
    prepared = [f"{QUERY_PREFIX}{t}" if kind == "query" and QUERY_PREFIX else t for t in texts]
    batch = _tokenizer(
        prepared, padding=True, truncation=True, max_length=MAX_TOKENS, return_tensors="pt"
    )
    with torch.no_grad(), _lock:
        out = _model(**batch).last_hidden_state
    mask = batch["attention_mask"].unsqueeze(-1).float()
    vec = (out * mask).sum(1) / mask.sum(1).clamp(min=1e-6)
    vec = F.normalize(vec, p=2, dim=1)
    return [[round(float(x), 6) for x in row] for row in vec.tolist()]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 别刷屏
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            return {}
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/health":
            return self._send(
                {"ok": True, "model": os.path.basename(MODEL_DIR), "dim": _dim, "loaded": _model is not None}
            )
        return self._send({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        path = self.path.split("?")[0]
        if path != "/embed":
            return self._send({"ok": False, "error": "not found"}, 404)
        payload = self._read_json()
        texts = payload.get("texts")
        if not isinstance(texts, list) or not texts:
            return self._send({"ok": False, "error": "texts 不能为空"}, 400)
        texts = [str(t) for t in texts][:MAX_TEXTS]
        kind = "query" if str(payload.get("kind") or "doc") == "query" else "doc"
        try:
            started = time.time()
            vectors = encode(texts, kind)
            cost = time.time() - started
            if cost > 0.5:
                log.info("编码 %d 条 kind=%s 用时 %.2fs", len(texts), kind, cost)
            return self._send({"ok": True, "dim": _dim, "model": os.path.basename(MODEL_DIR), "vectors": vectors})
        except Exception as exc:
            log.exception("编码失败")
            return self._send({"ok": False, "error": str(exc)}, 500)


def main():
    global log
    log = setup_logging()
    log.info("向量服务启动 %s:%s model=%s", HOST, PORT, MODEL_DIR)
    try:
        load_model()  # 先加载，别让第一句检索等 2 秒
    except Exception as exc:
        log.exception("模型加载失败：%s（服务仍会起来，但 /embed 会失败）", exc)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("收到中断，退出")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
