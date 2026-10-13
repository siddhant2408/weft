"""SQLite mirror check for host.py. Run: python3 native-host/test_mirror.py"""
import json, os, sqlite3, struct, subprocess, tempfile

HOST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "host.py")
DB = os.path.join(tempfile.mkdtemp(), "sub", "notes.db")  # missing parent dir: host must create it


def call(req):
    data = json.dumps(req).encode()
    env = {"HOME": os.environ["HOME"], "PATH": "/usr/bin:/bin", "MARGIN_DB": DB}
    p = subprocess.run(["/usr/bin/python3", HOST], input=struct.pack("<I", len(data)) + data, capture_output=True, env=env, timeout=30)
    return json.loads(p.stdout[4:4 + struct.unpack("<I", p.stdout[:4])[0]])


def rows():
    with sqlite3.connect(DB) as db:
        return {k: (json.loads(j), u) for k, j, u in db.execute("SELECT key, json, updated_at FROM pages")}


page = {"urlKey": "example.com/a", "title": "A", "highlights": [{"id": "h1", "messages": []}], "updatedAt": "2026-10-12T00:00:00Z"}
assert call({"mirror": {"key": "page:example.com/a", "page": page}})["ok"]
assert rows() == {"page:example.com/a": (page, "2026-10-12T00:00:00Z")}, rows()

page["title"] = "A2"
assert call({"mirror": {"key": "page:example.com/a", "page": page}})["ok"]
assert rows()["page:example.com/a"][0]["title"] == "A2", rows()
print("save + overwrite ok")

assert call({"mirror": {"key": "page:example.com/a", "page": None}})["ok"]
assert rows() == {}, rows()
print("delete ok")

for bad in ({"key": "settings", "page": {}}, {"key": "page:x", "page": "str"}, "nope"):
    r = call({"mirror": bad})
    assert r["code"] == "BAD_REQUEST", r
print("bad mirror requests rejected")

r = call({"system": "x", "prompt": "Reply with exactly: pong"})
assert r["code"] == "BAD_REQUEST", r
print("model requests rejected")
