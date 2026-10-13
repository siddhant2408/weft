#!/usr/bin/env python3
"""Chrome native messaging host: one request in, one reply out.

Mirror:   {"mirror": {"key": "page:…", "page": {...} | null}}
          copies one page record into a SQLite file that outlives the extension; null deletes it.
ChatGPT:  {"chatgpt": "signin" | "token" | "status" | "signout"}
          Sign in with ChatGPT; the host keeps the credentials (see chatgpt.py).
Runs under Chrome's minimal env (/usr/bin/python3 3.9, bare PATH), so keep it stdlib + 3.9.
"""
import json, os, sqlite3, struct, sys, time

import chatgpt

LOG = os.path.expanduser("~/Library/Logs/margin-host.log")
DB = os.environ.get("MARGIN_DB") or os.path.expanduser("~/Library/Application Support/Margin/notes.db")


def read_msg():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    return json.loads(sys.stdin.buffer.read(struct.unpack("<I", raw)[0]))


def write_msg(obj):
    data = json.dumps(obj).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def log(**kw):
    with open(LOG, "a") as f:  # no page contents, by design
        f.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), **kw}) + "\n")


def mirror(m):
    key, page = m.get("key") if isinstance(m, dict) else None, m.get("page") if isinstance(m, dict) else None
    if not isinstance(key, str) or not key.startswith("page:") or not (page is None or isinstance(page, dict)):
        return {"ok": False, "code": "BAD_REQUEST", "detail": "expected {key, page}"}
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    db = sqlite3.connect(DB, timeout=10)
    try:
        with db:
            db.execute("CREATE TABLE IF NOT EXISTS pages (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT)")
            if page is None:
                db.execute("DELETE FROM pages WHERE key = ?", (key,))
            else:
                db.execute("INSERT OR REPLACE INTO pages VALUES (?, ?, ?)", (key, json.dumps(page), page.get("updatedAt")))
    finally:
        db.close()
    return {"ok": True}


def main():
    req = read_msg()
    t0 = time.time()
    try:
        if isinstance(req, dict) and "mirror" in req:
            res = mirror(req["mirror"])
        elif isinstance(req, dict) and "chatgpt" in req:
            res = chatgpt.handle(req["chatgpt"])
        else:
            res = {"ok": False, "code": "BAD_REQUEST", "detail": "expected {mirror} or {chatgpt}"}
    except Exception as e:  # never leave Chrome without a reply
        res = {"ok": False, "code": "HOST_ERROR", "detail": repr(e)[:500]}
    res["ms"] = int((time.time() - t0) * 1000)
    log(ok=res["ok"], code=res.get("code"), ms=res["ms"])
    write_msg(res)


if __name__ == "__main__":
    main()
