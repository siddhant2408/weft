#!/usr/bin/env python3
"""Chrome native messaging host: one request in, one reply out. Two kinds of request:

Ask:      {"system": str, "prompt": str, "model"?: str, "effort"?: "low"|"medium"|"high"|"xhigh"|"max"}
          runs `claude -p` once → {"ok": true, "text", "ms", "usage"} or {"ok": false, "code", "detail"}
Mirror:   {"mirror": {"key": "page:…", "page": {...} | null}}
          copies one page record into a SQLite file that outlives the extension; null deletes it.
Runs under Chrome's minimal env (/usr/bin/python3 3.9, bare PATH), so keep it stdlib + 3.9.
"""
import json, os, re, sqlite3, struct, subprocess, sys, tempfile, time

CLAUDE = os.path.expanduser("~/.local/bin/claude")
LOG = os.path.expanduser("~/Library/Logs/margin-host.log")
DB = os.environ.get("MARGIN_DB") or os.path.expanduser("~/Library/Application Support/Margin/notes.db")
TIMEOUT_S = 120
EFFORTS = {"low", "medium", "high", "xhigh", "max"}
MODEL_RE = re.compile(r"^[a-z0-9][a-z0-9.\-]{0,63}$")  # alias (opus, sonnet…) or full model id
# Verified in M0 (Claude Code 2.1.296): no tools, no MCP, no user/project settings (so no
# hooks, plugins, CLAUDE.md), system prompt replaced. ~650 tokens overhead, ~3.5 s floor.
FLAGS = ["--tools", "", "--strict-mcp-config", "--setting-sources", "",
         "--disable-slash-commands", "--no-session-persistence", "--output-format", "json"]


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
    with open(LOG, "a") as f:  # no prompt text, by design
        f.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), **kw}) + "\n")


def ask(req):
    if not isinstance(req, dict) or not isinstance(req.get("prompt"), str) or not isinstance(req.get("system", ""), str):
        return {"ok": False, "code": "BAD_REQUEST", "detail": "expected {system, prompt}"}
    if not os.path.exists(CLAUDE):
        return {"ok": False, "code": "NOT_INSTALLED", "detail": "Claude Code not found at " + CLAUDE}
    with tempfile.TemporaryDirectory() as cwd:  # empty cwd: nothing to read even if a tool slipped through
        sys_file = os.path.join(cwd, "system.txt")
        with open(sys_file, "w") as f:
            f.write(req.get("system") or "You are a reading companion.")
        cmd = [CLAUDE, "-p", *FLAGS, "--system-prompt-file", sys_file]
        model, effort = req.get("model"), req.get("effort")
        if model:
            if not isinstance(model, str) or not MODEL_RE.match(model):
                return {"ok": False, "code": "BAD_REQUEST", "detail": "invalid model"}
            cmd += ["--model", model]
        if effort:
            if effort not in EFFORTS:
                return {"ok": False, "code": "BAD_REQUEST", "detail": "invalid effort"}
            cmd += ["--effort", effort]
        try:
            p = subprocess.run(cmd, input=req["prompt"], capture_output=True, text=True, cwd=cwd, timeout=TIMEOUT_S)
        except subprocess.TimeoutExpired:
            return {"ok": False, "code": "TIMEOUT", "detail": f"no reply in {TIMEOUT_S}s"}
    try:
        out = json.loads(p.stdout)
    except ValueError:
        err = (p.stderr or p.stdout).strip()[:500]
        code = "NOT_LOGGED_IN" if any(w in err.lower() for w in ("login", "log in", "auth")) else "CLI_ERROR"
        return {"ok": False, "code": code, "detail": err}
    if out.get("is_error"):
        res = str(out.get("result", ""))
        code = "NOT_LOGGED_IN" if any(w in res.lower() for w in ("login", "log in", "auth")) else "CLI_ERROR"
        return {"ok": False, "code": code, "detail": res[:500]}
    return {"ok": True, "text": out.get("result", ""), "usage": out.get("usage", {})}


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
        res = mirror(req["mirror"]) if isinstance(req, dict) and "mirror" in req else ask(req)
    except Exception as e:  # never leave Chrome without a reply
        res = {"ok": False, "code": "CLI_ERROR", "detail": repr(e)[:500]}
    res["ms"] = int((time.time() - t0) * 1000)
    log(ok=res["ok"], code=res.get("code"), ms=res["ms"])
    write_msg(res)


if __name__ == "__main__":
    main()
