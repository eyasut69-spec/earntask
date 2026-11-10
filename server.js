"use strict";
// EarnTask server - no dependencies. Run: ADMIN_PASSWORD=yourpass node server.js
const http = require("http"), https = require("https"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const GCID = process.env.GOOGLE_CLIENT_ID || "";
if (!ADMIN_PASSWORD) { console.error("Set ADMIN_PASSWORD first, e.g. ADMIN_PASSWORD=MySecret123 node server.js"); process.exit(1); }

const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(path.join(DATA, "uploads"), { recursive: true });
const FILE = path.join(DATA, "db.json");
let DB = { users: {}, sessions: {}, subs: [], wds: [], hashes: {}, seq: 1 };
try { DB = Object.assign(DB, JSON.parse(fs.readFileSync(FILE, "utf8"))); } catch (e) {}
let dirty = false; const touch = () => { dirty = true; };
const flush = () => { fs.writeFileSync(FILE + ".tmp", JSON.stringify(DB)); fs.renameSync(FILE + ".tmp", FILE); };
setInterval(() => { if (dirty) { dirty = false; flush(); } }, 1000);
process.on("SIGTERM", () => { flush(); process.exit(0); });

// ---------- settings (change here) ----------
const DAY = 864e5, REF_BONUS = 180, RATE = 180;
const TASKS = {
  vid: { r: 25, w: 60, u: "https://youtu.be/LEJwr_7AykA?si=SzkOwOhHdHdu7l88" },
  grp: { r: 15, w: 30, u: "https://t.me/etofol" },
  sub: { r: 35, w: 30, u: "https://youtube.com/@ethomidya?si=OPWMmGIlFAU78Xtq" },
};
const LIM = { etb: [2000, 30000], usdt: [100, 500] };
const FIELDS = { USDT: ["net", "addr"], Binance: ["pid"], Telebirr: ["ph", "nm"], CBE: ["ac", "nm"],
  "CBE Birr": ["ph", "nm"], Abyssinia: ["ac", "nm"], "M-Pesa": ["ph", "nm"] };
const USDT = ["USDT", "Binance"];

// ---------- helpers ----------
const fieldOk = (k, v, d) => {
  if (typeof v !== "string" || v.length > 100) return false;
  if (k === "nm") return /^\S+ \S+/.test(v);
  if (k === "ph") return /^\+?\d{9,15}$/.test(v.replace(/[\s-]/g, ""));
  if (k === "ac") return /^\d{6,20}$/.test(v);
  if (k === "pid") return /^\d{6,12}$/.test(v);
  if (k === "net") return v === "TRC20" || v === "BEP20";
  if (k === "addr") return d.net === "TRC20" ? /^T[a-zA-Z0-9]{33}$/.test(v) : /^0x[a-fA-F0-9]{40}$/.test(v);
  return false;
};
const phoneOk = (cc, d) => /^\d{1,4}$/.test(cc) && (cc === "251" ? /^[79]\d{8}$/.test(d) : /^\d{6,12}$/.test(d));
const hash = (pw, salt = crypto.randomBytes(8).toString("hex")) => salt + ":" + crypto.scryptSync(pw, salt, 32).toString("hex");
const check = (pw, h) => { const x = hash(pw, h.split(":")[0]); return x.length === h.length && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(h)); };
const J = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const E = (res, error, code = 400) => J(res, code, { error });
const body = req => new Promise((ok, no) => {
  const b = []; let n = 0;
  req.on("data", c => { n += c.length; if (n > 4e6) { no({ error: "badimg" }); req.destroy(); } else b.push(c); });
  req.on("end", () => { try { ok(JSON.parse(Buffer.concat(b).toString() || "{}")); } catch (e) { no({ error: "bad" }); } });
});
const hits = {};
const limited = req => {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0], n = Date.now();
  hits[ip] = (hits[ip] || []).filter(t => n - t < 6e5); hits[ip].push(n); return hits[ip].length > 30;
};
const userOf = req => { const id = DB.sessions[req.headers.authorization || ""]; return id && DB.users[id]; };
const AD = new Map();   // admin tokens -> expiry
const isAdmin = (req, q) => { const t = req.headers.authorization || q.get("t") || ""; const e = AD.get(t); return e && e > Date.now(); };
const lastSub = (uid, k) => { for (let i = DB.subs.length - 1; i >= 0; i--) { const s = DB.subs[i]; if (s.uid === uid && s.task === k) return { status: s.status, t: s.t }; } return null; };
const pub = u => ({
  id: u.id, label: u.label, bal: u.bal, code: u.code, refs: u.refs, refEarn: u.refEarn, now: Date.now(),
  tasks: Object.fromEntries(Object.keys(TASKS).map(k => [k, { started: u.starts[k] || 0, last: lastSub(u.id, k) }])),
  wds: DB.wds.filter(w => w.uid === u.id).slice(-20).reverse().map(w => ({ m: w.method, a: w.amount, c: w.cur, st: w.status, t: w.t })),
});
function newUser(id, label, pw, ref) {
  const code = crypto.randomBytes(5).toString("hex");
  const refBy = Object.keys(DB.users).find(k => DB.users[k].code === ref && k !== id) || null;
  DB.users[id] = { id, label, pw, code, bal: 0, refBy, refPaid: false, refs: 0, refEarn: 0, starts: {}, created: Date.now() };
}
function session(id) { const t = crypto.randomBytes(24).toString("hex"); DB.sessions[t] = id; touch(); return t; }
const gverify = cred => new Promise(ok => {
  https.get("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(cred), r => {
    let d = ""; r.on("data", c => d += c);
    r.on("end", () => { try { const j = JSON.parse(d); ok(j.aud === GCID && String(j.email_verified) === "true" ? j : null); } catch (e) { ok(null); } });
  }).on("error", () => ok(null));
});
const label = u => u.label;

// ---------- API ----------
async function api(req, res, p, q) {
  const get = req.method === "GET";
  if (p === "config" && get) return J(res, 200, { tasks: TASKS, googleClientId: GCID, ref: REF_BONUS });
  if (get && p === "me") { const u = userOf(req); return u ? J(res, 200, pub(u)) : E(res, "unauth", 401); }
  if (get && p === "admin/data") {
    if (!isAdmin(req, q)) return E(res, "unauth", 401);
    const us = Object.values(DB.users);
    return J(res, 200, {
      stats: { users: us.length, owed: us.reduce((a, u) => a + u.bal, 0),
        pTasks: DB.subs.filter(s => s.status === "pending").length,
        pWd: DB.wds.filter(w => w.status === "pending").length,
        paid: DB.wds.filter(w => w.status === "paid").reduce((a, w) => a + w.etb, 0) },
      tasks: DB.subs.filter(s => s.status === "pending").map(s => ({ id: s.id, user: DB.users[s.uid].label, task: s.task, r: TASKS[s.task].r, t: s.t })),
      wds: DB.wds.filter(w => w.status === "pending").map(w => ({ id: w.id, user: DB.users[w.uid].label, m: w.method, f: w.fields, a: w.amount, c: w.cur, etb: w.etb, t: w.t })),
      users: us.sort((a, b) => b.bal - a.bal).slice(0, 50).map(u => ({ label: u.label, bal: u.bal, refs: u.refs })),
    });
  }
  if (get) return E(res, "bad", 404);
  if (limited(req)) return E(res, "toomany", 429);
  const b = await body(req);

  if (p === "admin/login") {
    if (typeof b.password !== "string" || b.password.length !== ADMIN_PASSWORD.length ||
        !crypto.timingSafeEqual(Buffer.from(b.password), Buffer.from(ADMIN_PASSWORD))) return E(res, "wrong", 401);
    const t = crypto.randomBytes(24).toString("hex"); AD.set(t, Date.now() + 12 * 36e5); return J(res, 200, { token: t });
  }
  if (p === "admin/task" || p === "admin/wd") {
    if (!isAdmin(req, q)) return E(res, "unauth", 401);
    if (p === "admin/task") {
      const s = DB.subs.find(x => x.id === b.id && x.status === "pending"); if (!s) return E(res, "bad");
      const u = DB.users[s.uid];
      if (b.ok) {
        s.status = "approved"; u.bal += TASKS[s.task].r;
        if (u.refBy && !u.refPaid) { const r = DB.users[u.refBy]; u.refPaid = true; if (r) { r.bal += REF_BONUS; r.refs++; r.refEarn += REF_BONUS; } }
      } else { s.status = "rejected"; delete DB.hashes[s.hash]; }
    } else {
      const w = DB.wds.find(x => x.id === b.id && x.status === "pending"); if (!w) return E(res, "bad");
      if (b.ok) w.status = "paid"; else { w.status = "rejected"; DB.users[w.uid].bal += w.etb; }
    }
    touch(); return J(res, 200, { ok: 1 });
  }

  if (p === "register" || p === "login") {
    const d = String(b.phone || "").replace(/\D/g, "").replace(/^0+/, ""), cc = String(b.cc || ""), pw = String(b.password || "");
    if (!phoneOk(cc, d)) return E(res, "badphone");
    if (pw.length < 6 || pw.length > 100) return E(res, "badpass");
    const id = "p:" + cc + d, ex = DB.users[id];
    if (p === "register") {
      if (ex) return E(res, "exists");
      newUser(id, "+" + cc + d, hash(pw), String(b.ref || ""));
    } else if (!ex) return E(res, "nouser");
    else if (!check(pw, ex.pw)) return E(res, "wrong");
    return J(res, 200, { token: session(id) });
  }
  if (p === "google") {
    if (!GCID) return E(res, "bad");
    const g = await gverify(String(b.credential || "")); if (!g) return E(res, "wrong");
    const id = "g:" + g.sub; if (!DB.users[id]) newUser(id, g.email, "", String(b.ref || ""));
    return J(res, 200, { token: session(id) });
  }

  const u = userOf(req); if (!u) return E(res, "unauth", 401);
  if (p === "task/start") {
    const k = b.task; if (!TASKS[k]) return E(res, "bad");
    const l = lastSub(u.id, k);
    if (l && l.status !== "rejected" && Date.now() - l.t < DAY) return E(res, "cooling");
    u.starts[k] = Date.now(); touch(); return J(res, 200, { ok: 1 });
  }
  if (p === "task/submit") {
    const k = b.task; if (!TASKS[k]) return E(res, "bad");
    const l = lastSub(u.id, k);
    if (l && l.status !== "rejected" && Date.now() - l.t < DAY) return E(res, "cooling");
    if (!u.starts[k]) return E(res, "notstart");
    if (Date.now() - u.starts[k] < TASKS[k].w * 1000 - 1500) return E(res, "early");
    const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image || ""));
    if (!m) return E(res, "badimg");
    const buf = Buffer.from(m[2], "base64"); if (buf.length < 2000 || buf.length > 3e6) return E(res, "badimg");
    const h = crypto.createHash("sha256").update(buf).digest("hex");
    if (DB.hashes[h]) return E(res, "dup");
    const id = DB.seq++; fs.writeFileSync(path.join(DATA, "uploads", id + ".jpg"), buf);
    DB.hashes[h] = id; delete u.starts[k];
    DB.subs.push({ id, uid: u.id, task: k, t: Date.now(), status: "pending", hash: h }); touch();
    return J(res, 200, { ok: 1 });
  }
  if (p === "withdraw") {
    const m = b.method, f = b.fields || {}, a = Number(b.amount);
    if (!FIELDS[m]) return E(res, "bad");
    for (const k of FIELDS[m]) if (!fieldOk(k, String(f[k] || "").trim(), f)) return E(res, "badf");
    const us = USDT.includes(m), lim = us ? LIM.usdt : LIM.etb, etb = us ? a * RATE : a;
    if (!(a >= lim[0] && a <= lim[1]) || etb > u.bal) return E(res, "low");
    const fields = {}; for (const k of FIELDS[m]) fields[k] = String(f[k]).trim();
    u.bal -= etb; DB.wds.push({ id: DB.seq++, uid: u.id, method: m, fields, amount: a, cur: us ? "USDT" : "ETB", etb, status: "pending", t: Date.now() });
    touch(); return J(res, 200, { ok: 1 });
  }
  return E(res, "bad", 404);
}

// ---------- server ----------
const send = (res, f, type) => { try { res.writeHead(200, { "Content-Type": type }); res.end(fs.readFileSync(path.join(__dirname, f))); } catch (e) { res.writeHead(404); res.end("missing " + f); } };
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x"), p = url.pathname;
  try {
    if (p.startsWith("/api/")) return await api(req, res, p.slice(5), url.searchParams);
    if (p === "/admin") return send(res, "admin.html", "text/html; charset=utf-8");
    if (p.startsWith("/uploads/")) {
      if (!isAdmin(req, url.searchParams)) { res.writeHead(401); return res.end(); }
      const f = path.join(DATA, "uploads", path.basename(p));
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private" }); return res.end(fs.readFileSync(f));
    }
    return send(res, "index.html", "text/html; charset=utf-8");
  } catch (e) { if (!res.headersSent) E(res, e && e.error ? e.error : "bad", 400); }
}).listen(PORT, () => console.log("EarnTask running on port " + PORT));
