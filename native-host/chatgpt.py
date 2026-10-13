"""Sign in with ChatGPT for Margin, run by host.py. Holds the credentials so the 30-day refresh token never enters the
browser: the extension only ever receives a 1-hour access token. Flow per developers.openai.com/siwc/token-sharing-open-source.

Requests ({"chatgpt": ...}):  signin → listens on 127.0.0.1:1455, opens the sign-in page, waits for the redirect,
                                       exchanges the code, validates, stores → {ok, email}
                              token  → {ok, token, expiresAt}, refreshing first if it expires within a minute
                              status → {ok, signedIn, email, plan}
                              signout→ revokes the refresh token, forgets tokens (keeps client/host IDs) → {ok, revoked}
Credentials: one macOS Keychain item (service "Margin ChatGPT"), written through `security -i` on stdin so tokens never
appear in a process list. It is encrypted at rest; any process running as this user can still read it via `security`.
MARGIN_CREDS=<file> stores them in an owner-only file instead (tests). Stdlib + Python 3.9 only.
"""
import base64, fcntl, hashlib, http.server, json, os, secrets, subprocess, time, urllib.error, urllib.parse, urllib.request, uuid

AUTH = os.environ.get("MARGIN_AUTH") or "https://auth.openai.com"
ISSUER = "https://auth.openai.com"
RESOURCE = "https://api.openai.com/v1"
PORT = int(os.environ.get("MARGIN_CALLBACK_PORT") or 1455)
SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
PLAN_SCOPE = "chatgpt.tokens.use.direct"
SIGNIN_TIMEOUT_S = 300
DIR = os.path.expanduser("~/Library/Application Support/Margin")
LOCK = os.path.join(DIR, "chatgpt.lock")
SERVICE, ACCOUNT = os.environ.get("MARGIN_KEYCHAIN_SERVICE") or "Margin ChatGPT", "default"
TOKENS = ("accessToken", "refreshToken", "idToken", "expiresAt", "scopes")
UNUSABLE = {"invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"}


# --- credential store -------------------------------------------------------------------------------------------
def load():
    path = os.environ.get("MARGIN_CREDS")
    if path:
        try:
            with open(path) as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}
    p = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"], capture_output=True, text=True)
    try:
        return json.loads(p.stdout) if p.returncode == 0 else {}
    except ValueError:
        return {}


def save(creds):
    data = json.dumps(creds)
    path = os.environ.get("MARGIN_CREDS")
    if path:
        tmp = path + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(data)
        os.replace(tmp, path)
        return
    # -X takes the secret as hex; sending the command on stdin keeps it out of argv.
    cmd = 'add-generic-password -U -s "%s" -a "%s" -X %s\n' % (SERVICE, ACCOUNT, data.encode().hex())
    p = subprocess.run(["/usr/bin/security", "-i"], input=cmd, capture_output=True, text=True)
    if p.returncode != 0 or p.stderr.strip():
        raise RuntimeError("Keychain write failed: " + p.stderr.strip()[:200])


class Lock:
    """Serialises refresh/sign-in/sign-out across host processes: refresh tokens rotate, so two refreshes would race."""
    def __enter__(self):
        os.makedirs(DIR, exist_ok=True)
        self.f = open(os.environ.get("MARGIN_LOCK") or LOCK, "a")
        fcntl.flock(self.f, fcntl.LOCK_EX)

    def __exit__(self, *exc):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


# --- HTTP ---------------------------------------------------------------------------------------------------------
def post_form(url, form):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(form).encode(), headers={"content-type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def token_request(form):
    try:
        status, raw = post_form(AUTH + "/api/accounts/oauth/token", dict(form, resource=RESOURCE))
    except OSError as e:
        return {"ok": False, "code": "NETWORK", "detail": str(e)[:300]}
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        body = {}
    if status != 200:
        return {"ok": False, "code": body.get("error") or "HTTP_%d" % status, "detail": str(body.get("error_description") or body.get("detail") or "")[:300]}
    return dict(body, ok=True)


def b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def claims(jwt):
    part = jwt.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))


def with_tokens(creds, tok):
    return dict(creds, accessToken=tok["access_token"], refreshToken=tok.get("refresh_token") or creds.get("refreshToken"),
                idToken=tok.get("id_token") or creds.get("idToken"), expiresAt=int(time.time() * 1000) + int(tok.get("expires_in", 3600)) * 1000,
                scopes=str(tok.get("scope") or "").split())


# --- sign-in ------------------------------------------------------------------------------------------------------
def authorize_url(creds, redirect, state, nonce, verifier):
    params = {"client_id": creds.get("clientId") or "dynamic_agent_client", "ext_agent_host_id": creds["hostId"],
              "response_type": "code", "redirect_uri": redirect, "resource": RESOURCE, "scope": SCOPE, "state": state, "nonce": nonce,
              "code_challenge_method": "S256", "code_challenge": b64url(hashlib.sha256(verifier.encode()).digest())}
    if not creds.get("clientId"):
        params["agent_name_hint"] = "Margin"  # first registration only
    if creds.get("idToken"):
        params["id_token_hint"] = creds["idToken"]
    if creds.get("email"):
        params["login_hint"] = creds["email"]
    return AUTH + "/api/accounts/authorize?" + urllib.parse.urlencode(params)


def wait_for_callback(server, deadline):
    """Serves the loopback until the /auth/callback request arrives; returns its query parameters."""
    got = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            url = urllib.parse.urlsplit(self.path)
            if url.path != "/auth/callback":
                self.send_response(404); self.end_headers(); return
            got.update(urllib.parse.parse_qsl(url.query))
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write("<!doctype html><title>Margin</title><p style='font:16px system-ui;margin:40px'>Signed in. You can close this tab and return to Margin.".encode())

        def log_message(self, *args):  # never log URLs: they carry the code
            pass

    server.RequestHandlerClass = Handler
    while not got and time.time() < deadline:
        server.timeout = max(0.1, deadline - time.time())
        server.handle_request()
    return got


def signin(opener=None):
    with Lock():
        creds = load()
        if not creds.get("hostId"):
            creds["hostId"] = "urn:uuid:" + str(uuid.uuid4())  # stable per install, kept across sign-outs
            save(creds)
    try:
        server = http.server.HTTPServer(("127.0.0.1", PORT), http.server.BaseHTTPRequestHandler)
    except OSError:
        server = http.server.HTTPServer(("127.0.0.1", 0), http.server.BaseHTTPRequestHandler)  # only the port may vary
    redirect = "http://127.0.0.1:%d/auth/callback" % server.server_address[1]
    state, nonce, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(32), secrets.token_urlsafe(48)
    url = authorize_url(creds, redirect, state, nonce, verifier)
    try:
        (opener or (lambda u: subprocess.run(["/usr/bin/open", u], check=True)))(url)
        q = wait_for_callback(server, time.time() + SIGNIN_TIMEOUT_S)
    finally:
        server.server_close()
    if not q:
        return {"ok": False, "code": "SIGNIN_TIMEOUT"}
    if q.get("state") != state:
        return {"ok": False, "code": "SIGNIN_FAILED", "detail": "state mismatch"}
    if q.get("error"):
        return {"ok": False, "code": "SIGNIN_DECLINED" if q["error"] == "access_denied" else "SIGNIN_FAILED", "detail": q.get("error_description", q["error"])}
    client_id = creds.get("clientId") or q.get("client_id")
    if not client_id:
        return {"ok": False, "code": "SIGNIN_FAILED", "detail": "no client ID issued"}
    if creds.get("clientId") and q.get("client_id") and q["client_id"] != creds["clientId"]:
        return {"ok": False, "code": "SIGNIN_FAILED", "detail": "unexpected client ID"}
    tok = token_request({"grant_type": "authorization_code", "client_id": client_id, "code": q.get("code", ""), "code_verifier": verifier, "redirect_uri": redirect})
    if not tok["ok"]:
        return tok
    # Straight from the token endpoint over TLS, so the claims are checked without the signature (OIDC Core 3.1.3.7).
    try:
        idc = claims(tok["id_token"])
    except (KeyError, IndexError, ValueError):
        return {"ok": False, "code": "SIGNIN_FAILED", "detail": "unreadable ID token"}
    aud = idc.get("aud") if isinstance(idc.get("aud"), list) else [idc.get("aud")]
    if idc.get("iss") != ISSUER or client_id not in aud or idc.get("nonce") != nonce or idc.get("exp", 0) < time.time():
        return {"ok": False, "code": "SIGNIN_FAILED", "detail": "ID token did not validate"}
    with Lock():
        creds = load()
        if creds.get("sub") and creds.get("clientId") == client_id and creds["sub"] != idc.get("sub"):
            return {"ok": False, "code": "SIGNIN_FAILED", "detail": "a different ChatGPT account signed in"}
        creds = with_tokens(dict(creds, clientId=client_id, sub=idc.get("sub"), email=idc.get("email", "")), tok)
        save(creds)
    if PLAN_SCOPE not in creds["scopes"]:
        return {"ok": False, "code": "PLAN_NOT_GRANTED"}
    return {"ok": True, "email": creds["email"]}


# --- tokens, status, sign-out ---------------------------------------------------------------------------------------
def token():
    with Lock():
        creds = load()
        if not creds.get("refreshToken"):
            return {"ok": False, "code": "SIGNED_OUT"}
        if PLAN_SCOPE not in creds.get("scopes", []):
            return {"ok": False, "code": "PLAN_NOT_GRANTED"}
        if creds.get("expiresAt", 0) - 60000 > time.time() * 1000:
            return {"ok": True, "token": creds["accessToken"], "expiresAt": creds["expiresAt"]}
        tok = token_request({"grant_type": "refresh_token", "client_id": creds["clientId"], "refresh_token": creds["refreshToken"]})
        if tok["ok"]:
            creds = with_tokens(creds, tok)
            save(creds)
            return {"ok": True, "token": creds["accessToken"], "expiresAt": creds["expiresAt"]}
        if tok["code"] in UNUSABLE:  # keep client ID, host ID and email for the next sign-in
            save({k: v for k, v in creds.items() if k not in TOKENS})
            return {"ok": False, "code": "SIGNED_OUT", "detail": tok["code"]}
        return tok  # network or server trouble: keep the credentials


def status():
    creds = load()
    return {"ok": True, "signedIn": bool(creds.get("refreshToken")), "email": creds.get("email", ""), "plan": PLAN_SCOPE in creds.get("scopes", [])}


def signout():
    with Lock():
        creds = load()
        revoked = not creds.get("refreshToken")
        if creds.get("refreshToken"):
            try:
                with urllib.request.urlopen(AUTH + "/.well-known/openid-configuration", timeout=15) as r:
                    endpoint = json.load(r)["revocation_endpoint"]
                status_code, _ = post_form(endpoint, {"token": creds["refreshToken"], "token_type_hint": "refresh_token", "client_id": creds["clientId"]})
                revoked = status_code == 200
            except (OSError, ValueError, KeyError):
                pass  # forgotten locally anyway; the user can disconnect Margin in ChatGPT settings
        save({k: v for k, v in creds.items() if k not in TOKENS})
    return {"ok": True, "revoked": revoked}


def handle(action):
    fn = {"signin": signin, "token": token, "status": status, "signout": signout}.get(action)
    return fn() if fn else {"ok": False, "code": "BAD_REQUEST", "detail": "unknown chatgpt action"}
