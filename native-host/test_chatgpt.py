"""Sign in with ChatGPT in the host, against a fake auth.openai.com. Uses a temp credential file, plus one Keychain round
trip under a throwaway service name. Run: python3 native-host/test_chatgpt.py"""
import base64, hashlib, http.server, json, os, struct, subprocess, sys, tempfile, threading, time, urllib.parse, urllib.request

tmp = tempfile.mkdtemp()
fake = {"token_calls": [], "revoked": [], "delay": 0, "token_reply": None, "nonce": None}


class Fake(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(data)

    def do_GET(self):
        if self.path == "/.well-known/openid-configuration":
            return self.reply(200, {"revocation_endpoint": "http://127.0.0.1:%d/revoke" % PORT})
        self.reply(404, {})

    def do_POST(self):
        form = dict(urllib.parse.parse_qsl(self.rfile.read(int(self.headers["content-length"])).decode()))
        if self.path == "/revoke":
            fake["revoked"].append(form)
            return self.reply(200, {})
        fake["token_calls"].append(form)
        time.sleep(fake["delay"])
        status, body = fake["token_reply"](form)
        self.reply(status, body)


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fake)
PORT = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()
os.environ.update(MARGIN_AUTH="http://127.0.0.1:%d" % PORT, MARGIN_CREDS=os.path.join(tmp, "creds.json"),
                  MARGIN_LOCK=os.path.join(tmp, "lock"), MARGIN_CALLBACK_PORT="0")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chatgpt  # noqa: E402


def jwt(claims):
    return "h." + base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode() + ".sig"


def grant(access="A1", refresh="R1", scope="chatgpt.tokens.use.direct email offline_access openid profile resource.invoke", **claims):
    idc = dict({"iss": "https://auth.openai.com", "aud": "oaiapp_1", "nonce": fake["nonce"], "exp": time.time() + 3600, "sub": "u1", "email": "me@example.com"}, **claims)
    return 200, {"access_token": access, "refresh_token": refresh, "id_token": jwt(idc), "expires_in": 3600, "scope": scope}


def browser(extra=None, state=None):
    """Stands in for the user's browser: checks the authorize URL, then follows the redirect with a code."""
    seen = {}

    def opener(url):
        q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
        seen.update(q)
        fake["nonce"] = q["nonce"]
        cb = dict({"code": "CODE", "state": state or q["state"], "client_id": "oaiapp_1"}, **(extra or {}))
        threading.Thread(target=lambda: urllib.request.urlopen(q["redirect_uri"] + "?" + urllib.parse.urlencode(cb), timeout=10).read(), daemon=True).start()
    return opener, seen


# 1. First sign-in: dynamic registration with PKCE, loopback callback, code exchange, credentials saved.
fake["token_reply"] = lambda form: grant()
opener, seen = browser()
assert chatgpt.signin(opener) == {"ok": True, "email": "me@example.com"}
assert seen["client_id"] == "dynamic_agent_client" and seen["agent_name_hint"] == "Margin", seen
assert seen["redirect_uri"].startswith("http://127.0.0.1:") and seen["redirect_uri"].endswith("/auth/callback")
assert seen["resource"] == "https://api.openai.com/v1" and "chatgpt.tokens.use.direct" in seen["scope"]
form = fake["token_calls"][-1]
assert form["grant_type"] == "authorization_code" and form["client_id"] == "oaiapp_1" and form["redirect_uri"] == seen["redirect_uri"]
assert base64.urlsafe_b64encode(hashlib.sha256(form["code_verifier"].encode()).digest()).rstrip(b"=").decode() == seen["code_challenge"]
creds = chatgpt.load()
assert creds["clientId"] == "oaiapp_1" and creds["refreshToken"] == "R1" and creds["hostId"].startswith("urn:uuid:")
assert oct(os.stat(os.environ["MARGIN_CREDS"]).st_mode & 0o777) == "0o600"
print("sign-in ok")

# 2. Returning sign-in reuses client ID, host ID and hints; bad state / nonce / declined consent fail safely.
opener, seen = browser()
assert chatgpt.signin(opener)["ok"]
assert seen["client_id"] == "oaiapp_1" and "agent_name_hint" not in seen and seen["login_hint"] == "me@example.com" and seen["ext_agent_host_id"] == creds["hostId"]
calls = len(fake["token_calls"])
assert chatgpt.signin(browser(state="forged")[0])["code"] == "SIGNIN_FAILED"
assert chatgpt.signin(browser(extra={"error": "access_denied"})[0])["code"] == "SIGNIN_DECLINED"
assert len(fake["token_calls"]) == calls, "no code exchange after a bad callback"
fake["token_reply"] = lambda form: grant(nonce="wrong")
assert chatgpt.signin(browser()[0])["code"] == "SIGNIN_FAILED"
fake["token_reply"] = lambda form: grant(scope="openid email profile offline_access")
assert chatgpt.signin(browser()[0])["code"] == "PLAN_NOT_GRANTED"
assert chatgpt.token()["code"] == "PLAN_NOT_GRANTED"
fake["token_reply"] = lambda form: grant()
assert chatgpt.signin(browser()[0])["ok"]
print("returning sign-in and bad callbacks ok")

# 3. Tokens: fresh one as is; an expiring one refreshed exactly once even when two hosts ask at once.
assert chatgpt.token() == {"ok": True, "token": "A1", "expiresAt": chatgpt.load()["expiresAt"]}
c = chatgpt.load(); c["expiresAt"] = 0; chatgpt.save(c)
fake["delay"], fake["token_reply"] = 0.3, (lambda form: grant(access="A2", refresh="R2"))
calls, results = len(fake["token_calls"]), []
threads = [threading.Thread(target=lambda: results.append(chatgpt.token())) for _ in range(2)]
[t.start() for t in threads]; [t.join() for t in threads]
fake["delay"] = 0
assert [r["token"] for r in results] == ["A2", "A2"], results
assert len(fake["token_calls"]) == calls + 1, "refresh tokens rotate: only one refresh may run"
assert fake["token_calls"][-1] == {"grant_type": "refresh_token", "client_id": "oaiapp_1", "refresh_token": "R1", "resource": "https://api.openai.com/v1"}
print("refresh ok (single flight)")

# 4. Network trouble keeps credentials; a dead refresh token signs out but keeps client/host IDs.
c = chatgpt.load(); c["expiresAt"] = 0; chatgpt.save(c)
fake["token_reply"] = lambda form: (503, {"detail": "down"})
assert chatgpt.token()["code"] == "HTTP_503" and chatgpt.load()["refreshToken"] == "R2"
fake["token_reply"] = lambda form: (400, {"error": "refresh_token_reused"})
assert chatgpt.token()["code"] == "SIGNED_OUT"
assert set(chatgpt.load()) == {"clientId", "hostId", "sub", "email"}, chatgpt.load()
assert chatgpt.status() == {"ok": True, "signedIn": False, "email": "me@example.com", "plan": False}
print("refresh failures ok")

# 5. Sign-out revokes the refresh token and forgets tokens.
fake["token_reply"] = lambda form: grant(access="A3", refresh="R3")
assert chatgpt.signin(browser()[0])["ok"] and chatgpt.status()["signedIn"]
assert chatgpt.signout() == {"ok": True, "revoked": True}
assert fake["revoked"][-1] == {"token": "R3", "token_type_hint": "refresh_token", "client_id": "oaiapp_1"}
assert set(chatgpt.load()) == {"clientId", "hostId", "sub", "email"}
print("sign-out ok")

# 6. Through host.py over native messaging: no token ever goes to the log.
def call(req):
    data = json.dumps(req).encode()
    env = dict(os.environ, HOME=tmp)  # the host log goes under this HOME
    os.makedirs(os.path.join(tmp, "Library", "Logs"), exist_ok=True)
    p = subprocess.run(["/usr/bin/python3", os.path.join(os.path.dirname(os.path.abspath(__file__)), "host.py")],
                       input=struct.pack("<I", len(data)) + data, capture_output=True, env=env, timeout=30)
    n = struct.unpack("<I", p.stdout[:4])[0]
    return json.loads(p.stdout[4:4 + n])

fake["token_reply"] = lambda form: grant(access="SECRET_ACCESS", refresh="SECRET_REFRESH")
assert chatgpt.signin(browser()[0])["ok"]
assert call({"chatgpt": "token"})["token"] == "SECRET_ACCESS"
st = call({"chatgpt": "status"})
assert (st["signedIn"], st["plan"], st["email"]) == (True, True, "me@example.com") and "SECRET" not in json.dumps(st), st
assert call({"chatgpt": "nope"})["code"] == "BAD_REQUEST"
with open(os.path.join(tmp, "Library", "Logs", "margin-host.log")) as f:
    assert "SECRET" not in f.read()
print("host round-trip ok, log has no tokens")

# 7. Keychain store: hex through `security -i`, read back intact (throwaway service name, then deleted).
del os.environ["MARGIN_CREDS"]
chatgpt.SERVICE = "Margin ChatGPT test %d" % os.getpid()
try:
    record = {"refreshToken": "r/+=\"'$x", "email": "me@example.com", "n": 1}
    chatgpt.save(record)
    assert chatgpt.load() == record
    ps = subprocess.run(["ps", "-axo", "args"], capture_output=True, text=True).stdout
    assert "r/+=" not in ps
finally:
    subprocess.run(["/usr/bin/security", "delete-generic-password", "-s", chatgpt.SERVICE, "-a", chatgpt.ACCOUNT], capture_output=True)
print("keychain round-trip ok")
print("chatgpt host: all passed")
