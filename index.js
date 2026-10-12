#!/usr/bin/env node
/**
 * =============================================================================
 *  Marzban — KataBump Edition
 * -----------------------------------------------------------------------------
 *  Two files only:  index.js  +  package.json
 *
 *  Marzban is a Python application whose official installer wants root, docker
 *  and systemd. A KataBump container gives you an unprivileged box with ONE
 *  public TCP port and expects a plain `node index.js` in the foreground.
 *
 *  So: node owns the public port and drives the Python side as a child process.
 *
 *    1. opens the public port immediately, serves a self-refreshing page
 *    2. finds a usable Python 3.10–3.13 (downloads a portable CPython if the
 *       image has none — KataBump's node images are not guaranteed to ship one)
 *    3. downloads the official Marzban source release + Xray-core (cached)
 *    4. creates a persistent virtualenv and pip-installs Marzban's own pinned
 *       requirements into it (first boot only)
 *    5. writes .env + a single-port xray_config.json, runs the alembic
 *       migrations, creates the first sudo admin with marzban-cli
 *    6. starts uvicorn (Marzban) on an INTERNAL port and multiplexes the public
 *       port:   /<tunnel path>   -> the xray inbound
 *               everything else  -> Marzban (HTTP + WebSocket, raw relay)
 *    7. restarts the panel automatically if it ever dies
 *
 *  Environment variables (all optional):
 *    SERVER_PORT / PORT      public port (else first free of 8080/3000/8000)
 *    PANEL_PORT              internal port for Marzban          (default 8000)
 *    ADMIN_USER              panel username                     (default admin)
 *    ADMIN_PASS              panel password                     (default random)
 *    FORCE_ADMIN=1           re-apply the credentials on an existing database
 *    MARZBAN_PUBLIC_HOST     host clients use (host or host:port) so that
 *                            subscription links are not built from 127.0.0.1
 *    MARZBAN_VERSION         release tag or branch              (default v0.8.4)
 *    XRAY_VERSION            Xray-core tag                      (default latest)
 *    XRAY_SUBSCRIPTION_PATH  subscription url path              (default sub)
 *    MARZBAN_TUNNELS         "vless:/mb-vless:21001,trojan:/mb-trojan:21002"
 *    MARZBAN_SKIP_XRAY=1     do not download/run xray-core
 *    MARZBAN_FORCE_SETUP=1   re-download / re-install everything
 *    MARZBAN_FORCE_HOSTS=1   overwrite host settings you changed by hand
 *    MARZBAN_PYTHON          absolute path to a python 3.10–3.13 interpreter
 *    MARZBAN_PORTABLE_PY=1   always use the downloaded portable CPython
 *    TZ                      timezone for the panel             (default UTC)
 *    KATABUMP_ROOT           data root                          (auto-detected)
 *    SELFTEST=1              run self-tests and exit
 * =============================================================================
 */

"use strict";

// KataBump's free plan gives the whole container 308 MB and Marzban itself
// needs ~130 MB, so keep V8's heap small and hand transient memory back after
// the heavy bootstrap steps. This also covers the case where the panel is
// started with a plain `node index.js` instead of `npm start`.
try {
  require("v8").setFlagsFromString("--max-old-space-size=48");
} catch (_) {}

function releaseMemory() {
  try {
    if (typeof global.gc === "function") global.gc();
  } catch (_) {}
}

const net = require("net");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { once } = require("events");

const WRAPPER = "marzban-katabump-1.0";
const UA = "marzban-katabump/" + WRAPPER;
const REPO = "Gozargah/Marzban";
const MARZBAN_VERSION = process.env.MARZBAN_VERSION || "v0.8.4";
const XRAY_VERSION = process.env.XRAY_VERSION || "latest";
const STATUS_PATH = "/_kb/status";
const TUNNEL_DEFAULT = "vless:/mb-vless:21001";

/* ------------------------------------------------------------------ paths */

const ROOT =
  process.env.KATABUMP_ROOT ||
  (fs.existsSync("/home/container") ? "/home/container" : __dirname);

const BASE = path.join(ROOT, "marzban");
const APP = path.join(BASE, "app"); // Marzban source
const VENV = path.join(BASE, "venv");
const PYLIBS = path.join(BASE, "pylibs"); // fallback when `python -m venv` fails
const PORTABLE = path.join(BASE, "python"); // downloaded CPython (only if needed)
const XRAY_DIR = path.join(BASE, "xray-core");
const DATA = path.join(BASE, "data");
const LOGS = path.join(BASE, "log");
const TMP = path.join(BASE, "tmp");
const STATE_FILE = path.join(BASE, "state.json");
const CRED_FILE = path.join(BASE, "PANEL.txt");
const REQ_FILE = path.join(BASE, "requirements-marzban.txt");
const XRAY_JSON = path.join(DATA, "xray_config.json");
const DB_FILE = path.join(DATA, "db.sqlite3");

// portable CPython (python-build-standalone) used only when the image has none
const PBS_TAG = process.env.MARZBAN_PYTHON_BUILD || "20261009";
const PBS_VERSION = "3.12.15";

/* ------------------------------------------------------------------- ports */

function int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : dflt;
}

function firstFreePort(candidates) {
  for (const p of candidates) {
    let ok = false;
    try {
      const s = net.createServer();
      s.listen(p, "0.0.0.0");
      s.close();
      ok = true;
    } catch (_) {}
    if (ok) return p;
  }
  return candidates[0];
}

const PUBLIC_PORT =
  int(process.env.SERVER_PORT || process.env.PORT, 0) ||
  firstFreePort([8080, 3000, 8000]);

let PANEL_PORT = int(process.env.PANEL_PORT, 8000);
if (PANEL_PORT === PUBLIC_PORT) PANEL_PORT = PUBLIC_PORT !== 8000 ? 8000 : 8100;

/* ----------------------------------------------------------------- tunnels */

function parseTunnels(spec) {
  const out = [];
  for (const raw of String(spec || "").split(",")) {
    const s = raw.trim();
    if (!s) continue;
    const parts = s.split(":");
    let proto, p, port;
    if (parts.length >= 3) {
      proto = parts[0].toLowerCase();
      p = parts[1];
      port = int(parts[parts.length - 1], 0);
    } else if (parts.length === 2) {
      proto = "vless";
      p = parts[0];
      port = int(parts[1], 0);
    } else continue;
    if (!p.startsWith("/")) p = "/" + p;
    if (port) out.push({ proto, path: p, port });
  }
  return out.length ? out : [{ proto: "vless", path: "/mb-vless", port: 21001 }];
}

const TUNNELS = parseTunnels(
  process.env.MARZBAN_TUNNELS !== undefined ? process.env.MARZBAN_TUNNELS : TUNNEL_DEFAULT
);

function routePort(urlPath) {
  for (const t of TUNNELS) {
    if (urlPath === t.path || urlPath.startsWith(t.path)) return { port: t.port, tunnel: t };
  }
  return { port: PANEL_PORT, tunnel: null };
}

/* ------------------------------------------------------------------ helpers */

const STATE = { panelUp: false, step: "booting", error: null };

const C = process.stdout.isTTY || process.env.FORCE_COLOR === "1";
const paint = (c, s) => (C ? `\x1b[${c}m${s}\x1b[0m` : s);
const log = (...a) => console.log("[marzban]", ...a);
const ok = (...a) => console.log(paint("32", "  ✓"), ...a);
const warn = (...a) => console.log(paint("33", "  !"), ...a);
const err = (...a) => console.log(paint("31", "  ✗"), ...a);
const step = (s) => {
  STATE.step = s;
  log(s);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function randomToken(len) {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (_) {
    return {};
  }
}

function saveState(patch) {
  try {
    fs.mkdirSync(BASE, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }, null, 2));
  } catch (_) {}
}

function ensureDirs() {
  for (const d of [BASE, XRAY_DIR, DATA, LOGS, TMP]) fs.mkdirSync(d, { recursive: true });
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (_) {}
}

/* --------------------------------------------------------------- downloads */

function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(e);
    }
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.request(
      u,
      {
        method: opts.method || "GET",
        headers: { "User-Agent": UA, ...(opts.headers || {}) },
        timeout: opts.timeout || 120000,
      },
      resolve
    );
    req.on("timeout", () => req.destroy(new Error("timeout: " + url)));
    req.on("error", reject);
    req.end();
  });
}

async function downloadFile(url, dest, label) {
  let current = url;
  for (let redirects = 0; ; redirects++) {
    const res = await request(current, { timeout: 180000 });
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      if (redirects > 5) throw new Error("too many redirects for " + url);
      current = new URL(res.headers.location, current).toString();
      continue;
    }
    if (res.statusCode !== 200) {
      res.resume();
      throw new Error(`HTTP ${res.statusCode} while downloading ${current}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + ".part";
    const file = fs.createWriteStream(tmp);
    const total = Number(res.headers["content-length"] || 0);
    let received = 0;
    let last = -1;
    await new Promise((resolve, reject) => {
      let done = false;
      const fail = (e) => {
        if (done) return;
        done = true;
        try {
          file.destroy();
        } catch (_) {}
        reject(e);
      };
      file.on("error", fail);
      res.on("error", fail);
      res.on("data", (c) => {
        received += c.length;
        if (total) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== last && pct % 25 === 0) {
            last = pct;
            log(`${label}: ${pct}% (${fmtBytes(received)} / ${fmtBytes(total)})`);
          }
        }
      });
      res.pipe(file);
      file.on("finish", () => {
        if (done) return;
        done = true;
        resolve();
      });
    });
    fs.renameSync(tmp, dest);
    log(`${label}: done (${fmtBytes(received)})`);
    return received;
  }
}

/* ------------------------------------------- tar.gz extraction (pure node) */

function octal(buf, start, len) {
  const s = buf.subarray(start, start + len).toString("utf8");
  const clean = s.replace(/\0/g, "").replace(/ /g, "").trim();
  if (!clean) return 0;
  if (buf[start] & 0x80) {
    let n = 0;
    for (let i = 0; i < len; i++) n = n * 256 + (buf[start + i] & 0xff);
    return n;
  }
  const v = parseInt(clean, 8);
  return Number.isFinite(v) ? v : 0;
}

function parsePax(buf) {
  const out = {};
  const s = buf.toString("utf8");
  let i = 0;
  while (i < s.length) {
    const sp = s.indexOf(" ", i);
    if (sp < 0) break;
    const len = parseInt(s.slice(i, sp), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = s.slice(sp + 1, i + len);
    const nl = rec.lastIndexOf("\n");
    const body = nl >= 0 ? rec.slice(0, nl) : rec;
    const eq = body.indexOf("=");
    if (eq > 0) {
      const k = body.slice(0, eq);
      const v = body.slice(eq + 1);
      if (k === "path") out.path = v;
      else if (k === "linkpath") out.linkpath = v;
      else if (k === "size") out.size = parseInt(v, 10);
    }
    i += len;
  }
  return out;
}

function parseTarHeader(h, longName, longLink, pax) {
  let name = h.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
  const prefix = h.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
  if (prefix && !name.startsWith("/")) name = prefix + "/" + name;
  let size = octal(h, 124, 12);
  const mode = octal(h, 100, 8) & 0o7777;
  let type = String.fromCharCode(h[156]);
  if (type === " ") type = "0";
  let link = h.subarray(157, 257).toString("utf8").replace(/\0.*$/, "");
  if (pax) {
    if (pax.path) name = pax.path;
    if (pax.size !== undefined) size = pax.size;
    if (pax.linkpath) link = pax.linkpath;
  }
  if (longName) name = longName;
  if (longLink) link = longLink;
  return { name, size, mode: mode || 0o644, type, link };
}

function isZeroBlock(b) {
  for (let i = 0; i < 512; i++) if (b[i] !== 0) return false;
  return true;
}

function safeJoin(destDir, name) {
  const clean = name.replace(/^(\.\.[/\\])+/, "").replace(/^\/+/, "");
  const target = path.resolve(destDir, clean);
  const root = path.resolve(destDir);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/** Stream a .tar.gz to disk — memory stays flat, no tar binary, no npm deps. */
async function extractTarGz(gzPath, destDir, strip = 0) {
  fs.mkdirSync(destDir, { recursive: true });
  const rs = fs.createReadStream(gzPath);
  const gunzip = zlib.createGunzip();
  rs.pipe(gunzip);

  let buf = Buffer.alloc(0);
  let cur = null;
  let longName = null;
  let longLink = null;
  let pax = null;
  let zeros = 0;
  let state = "header";
  let count = 0;

  const closeCurrent = async () => {
    if (cur && cur.ws) {
      cur.ws.end();
      await once(cur.ws, "finish");
      if (cur.mode) {
        try {
          fs.chmodSync(cur.target, cur.mode);
        } catch (_) {}
      }
    }
    cur = null;
  };

  for await (const chunk of gunzip) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (state === "header") {
        if (buf.length < 512) break;
        const header = buf.subarray(0, 512);
        buf = buf.subarray(512);
        if (isZeroBlock(header)) {
          zeros++;
          if (zeros >= 2) {
            rs.destroy();
            return count;
          }
          continue;
        }
        zeros = 0;
        const e = parseTarHeader(header, longName, longLink, pax);
        longName = longLink = pax = null;

        if (strip > 0) {
          const parts = e.name.split("/").filter((s) => s !== "" && s !== ".");
          if (parts.length <= strip) continue;
          e.name = parts.slice(strip).join("/");
        }

        if ("LKxXg".includes(e.type)) {
          if (e.size > 0) {
            cur = { ...e, written: 0, buf: Buffer.alloc(0) };
            state = "data";
          }
          continue;
        }

        const target = safeJoin(destDir, e.name);
        if (!target) continue;
        e.target = target;

        if (e.type === "5") {
          fs.mkdirSync(target, { recursive: true });
          try {
            fs.chmodSync(target, e.mode || 0o755);
          } catch (_) {}
          continue;
        }
        if (e.type === "2") {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          try {
            fs.symlinkSync(e.link, target);
          } catch (_) {}
          continue;
        }
        if (e.type !== "0" && e.type !== "7" && e.type !== "1") continue;

        cur = { ...e, written: 0, ws: null };
        state = "data";
        continue;
      }

      if (cur.written < cur.size) {
        const take = Math.min(buf.length, cur.size - cur.written);
        if (take > 0) {
          const slice = buf.subarray(0, take);
          buf = buf.subarray(take);
          cur.written += take;
          if ("LKxXg".includes(cur.type)) {
            cur.buf = cur.buf.length ? Buffer.concat([cur.buf, slice]) : slice;
          } else {
            if (!cur.ws) {
              fs.mkdirSync(path.dirname(cur.target), { recursive: true });
              cur.ws = fs.createWriteStream(cur.target, { mode: cur.mode || 0o644 });
            }
            if (!cur.ws.write(slice)) await once(cur.ws, "drain");
          }
        }
        if (cur.written < cur.size) break;
      }

      const padded = Math.ceil(cur.size / 512) * 512;
      let skip = padded - cur.size;
      while (skip > 0 && buf.length > 0) {
        const s = Math.min(skip, buf.length);
        buf = buf.subarray(s);
        skip -= s;
      }
      if (skip > 0) break;

      if (cur.type === "L") longName = cur.buf.toString("utf8").replace(/\0+$/, "");
      else if (cur.type === "K") longLink = cur.buf.toString("utf8").replace(/\0+$/, "");
      else if ("xXg".includes(cur.type)) pax = parsePax(cur.buf);
      else {
        await closeCurrent();
        count++;
      }
      cur = null;
      state = "header";
    }
  }
  await closeCurrent();
  return count;
}

/* ------------------------------------------------- running python commands */

/**
 * Run a command, streaming its output through our logger.
 * `show` filters noisy output; on failure the hidden tail is dumped so the
 * real error is never swallowed.
 */
function run(cmd, args, opts = {}) {
  const show = opts.show || null;
  return new Promise((resolve) => {
    if (!opts.quiet) log("$ " + [cmd, ...args].map((s) => String(s)).join(" "));
    const env = { ...process.env, PYTHONUNBUFFERED: "1", ...(opts.env || {}) };
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd || undefined,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      err(`${cmd}: ${e.message}`);
      return resolve({ code: 127, out: "", err: e.message });
    }

    let tail = [];
    const filter = opts.filter || null;
    const onChunk = (buf) => {
      for (const raw of buf.toString().split("\n")) {
        const line = raw.replace(/\s+$/, "");
        if (!line) continue;
        tail.push(line);
        if (tail.length > 400) tail.shift();
        if (opts.quiet) continue;
        if (!show || show.some((k) => line.includes(k))) {
          if (!filter || !filter.test(line)) console.log("   " + line.slice(0, 200));
        }
      }
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);

    const timer = opts.timeout
      ? setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch (_) {}
        }, opts.timeout)
      : null;

    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      err(`${cmd}: ${e.message}`);
      resolve({ code: 127, out: tail.join("\n"), err: e.message });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0 && show) {
        const shown = tail.filter((l) => show.some((k) => l.includes(k)));
        const hidden = tail.filter((l) => !show.some((k) => l.includes(k)));
        if (hidden.length && shown.length) {
          console.log(paint("31", "   --- last lines of the failed command ---"));
          for (const l of hidden.slice(-25)) console.log("   " + l.slice(0, 200));
        }
      }
      resolve({ code: code === null ? 1 : code, out: tail.join("\n") });
    });
  });
}

/** Run `python -c <script>` and return trimmed stdout. */
async function pyEval(py, script, opts = {}) {
  const r = await run(py, ["-c", script], { ...opts, show: null, timeout: opts.timeout || 120000 });
  return { code: r.code, out: r.out || "" };
}

/* --------------------------------------------------------- python discovery */

function pbsAsset() {
  const m = os.machine ? os.machine() : process.arch;
  const arch =
    m === "x86_64" || m === "amd64"
      ? "x86_64-unknown-linux-gnu"
      : m === "aarch64" || m === "arm64"
      ? "aarch64-unknown-linux-gnu"
      : null;
  if (!arch) return null;
  return {
    url:
      `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/` +
      `cpython-${PBS_VERSION}+${PBS_TAG}-${arch}-install_only_stripped.tar.gz`,
    name: `cpython-${PBS_VERSION}+${PBS_TAG}-${arch}-install_only_stripped.tar.gz`,
  };
}

async function pythonVersion(cand) {
  const r = await pyEval(cand, "import sys;print('%d.%d.%d'%sys.version_info[:3])", {
    quiet: true,
    timeout: 60000,
  });
  if (r.code !== 0) return null;
  const m = r.out.trim().match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { full: m[0], major: +m[1], minor: +m[2], patch: +m[3] };
}

function usable(v) {
  // Marzban needs 3.10+; its pinned wheels stop at 3.13 for the packages that
  // ship compiled extensions (we relax those pins, but 3.14 is untested).
  return v && v.major === 3 && v.minor >= 10 && v.minor <= 13;
}

async function findSystemPython() {
  const candidates = [
    process.env.MARZBAN_PYTHON,
    "python3",
    "python3.13",
    "python3.12",
    "python3.11",
    "python3.10",
    "python",
  ].filter(Boolean);
  for (const c of candidates) {
    const v = await pythonVersion(c);
    if (v) {
      if (usable(v)) return { py: c, version: v, portable: false };
      warn(`python ${v.full} found — Marzban needs 3.10–3.13`);
    }
  }
  return null;
}

async function installPortablePython() {
  const exe = path.join(PORTABLE, "bin", "python3");
  if (fs.existsSync(exe) && process.env.MARZBAN_FORCE_SETUP !== "1") {
    const v = await pythonVersion(exe);
    if (usable(v)) {
      ok(`portable python ${v.full} already installed`);
      return { py: exe, version: v, portable: true };
    }
  }
  const asset = pbsAsset();
  if (!asset) throw new Error(`unsupported CPU architecture: ${process.arch}`);
  step("downloading a portable Python 3.12 (the image has no usable python3) …");
  const gz = path.join(TMP, "python.tar.gz");
  await downloadFile(asset.url, gz, "python");
  rmrf(PORTABLE);
  fs.mkdirSync(PORTABLE, { recursive: true });
  await extractTarGz(gz, PORTABLE, 1);
  try {
    fs.unlinkSync(gz);
  } catch (_) {}
  if (!fs.existsSync(exe)) throw new Error("portable python download failed");
  try {
    fs.chmodSync(exe, 0o755);
  } catch (_) {}
  // the standalone build keeps its own cacert.pem — point SSL at it
  const cacert = path.join(PORTABLE, "lib", `python${PBS_VERSION.slice(0, 4)}`, "site-packages", "certifi", "cacert.pem");
  if (fs.existsSync(cacert)) process.env.SSL_CERT_FILE = cacert;
  const v = await pythonVersion(exe);
  if (!usable(v)) throw new Error("portable python is not usable");
  ok(`portable python ${v.full} ready: ${exe}`);
  return { py: exe, version: v, portable: true };
}

async function findPython() {
  if (process.env.MARZBAN_PORTABLE_PY === "1") return await installPortablePython();
  const found = await findSystemPython();
  if (found) {
    log(`python ${found.version.full} at ${found.py}`);
    return found;
  }
  log("no usable python3 in the image — fetching a portable one");
  return await installPortablePython();
}

/* ------------------------------------------------------- Marzban bootstrap */

function isTag(v) {
  return !!v && ((v[0] === "v" && /\d/.test(v[1] || "")) || /^\d/.test(v));
}

async function installMarzbanSource() {
  if (fs.existsSync(path.join(APP, "marzban-cli.py")) && process.env.MARZBAN_FORCE_SETUP !== "1") {
    ok(`Marzban source already present in ${APP}`);
    return;
  }
  const ref = isTag(MARZBAN_VERSION) ? "tags/" + MARZBAN_VERSION : "heads/" + MARZBAN_VERSION;
  const url = `https://codeload.github.com/${REPO}/tar.gz/refs/${ref}`;
  const gz = path.join(TMP, "marzban.tar.gz");
  step(`downloading Marzban ${MARZBAN_VERSION} …`);
  await downloadFile(url, gz, "source");
  rmrf(APP);
  fs.mkdirSync(APP, { recursive: true });
  const files = await extractTarGz(gz, APP, 1);
  try {
    fs.unlinkSync(gz);
  } catch (_) {}
  if (!fs.existsSync(path.join(APP, "marzban-cli.py"))) {
    throw new Error("Marzban source download failed (marzban-cli.py missing)");
  }
  ok(`Marzban source extracted to ${APP} (${files} files)`);
}

function xrayArch() {
  const m = os.machine ? os.machine() : process.arch;
  return (
    {
      x86_64: "64",
      amd64: "64",
      aarch64: "arm64-v8a",
      arm64: "arm64-v8a",
      armv7l: "arm32-v7a",
      armv6l: "arm32-v6",
      i386: "32",
      i686: "32",
    }[m] || "64"
  );
}

async function extractZipWith(py, zipPath, destDir, wanted) {
  const script = `
import zipfile, os, sys, stat
dest = sys.argv[1]
want = set(sys.argv[2].split(","))
os.makedirs(dest, exist_ok=True)
with zipfile.ZipFile(sys.argv[3]) as z:
    for name in z.namelist():
        base = os.path.basename(name)
        if base in want:
            with z.open(name) as src, open(os.path.join(dest, base), "wb") as out:
                out.write(src.read())
            if base == "xray":
                os.chmod(os.path.join(dest, base), 0o755)
print("extracted")
`;
  const r = await run(py, ["-c", script, destDir, wanted.join(","), zipPath], {
    show: ["extracted", "Error", "error", "Traceback"],
    timeout: 300000,
  });
  return r.code === 0;
}

async function installXray(py) {
  if (process.env.MARZBAN_SKIP_XRAY === "1") {
    warn("MARZBAN_SKIP_XRAY=1 — skipping xray-core (inbounds will not run)");
    return null;
  }
  const exe = path.join(XRAY_DIR, "xray");
  if (fs.existsSync(exe) && process.env.MARZBAN_FORCE_SETUP !== "1") {
    ok(`xray-core already present: ${exe}`);
    return exe;
  }
  const base =
    XRAY_VERSION === "latest"
      ? "https://github.com/XTLS/Xray-core/releases/latest/download"
      : `https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}`;
  const zf = path.join(TMP, "xray.zip");
  step("downloading Xray-core …");
  await downloadFile(`${base}/Xray-linux-${xrayArch()}.zip`, zf, "xray");
  const okZip = await extractZipWith(py, zf, XRAY_DIR, ["xray", "geoip.dat", "geosite.dat"]);
  try {
    fs.unlinkSync(zf);
  } catch (_) {}
  if (!okZip || !fs.existsSync(exe)) throw new Error("xray-core download failed");
  try {
    fs.chmodSync(exe, 0o755);
  } catch (_) {}
  ok(`xray-core ready: ${exe}`);
  return exe;
}

/* ------------------------------------------- xray config for a single port */

function writeXrayConfig() {
  fs.mkdirSync(DATA, { recursive: true });
  if (fs.existsSync(XRAY_JSON) && process.env.MARZBAN_FORCE_SETUP !== "1") return;

  const sniffing = { enabled: true, destOverride: ["http", "tls", "quic"], routeOnly: true };
  const inbounds = [];
  for (const t of TUNNELS) {
    const tag = `${t.proto.toUpperCase()} ${t.proto === "shadowsocks" ? "TCP" : "WS"} KATABUMP ${t.port}`;
    if (t.proto === "vless") {
      inbounds.push({
        tag,
        listen: "127.0.0.1",
        port: t.port,
        protocol: "vless",
        settings: { clients: [], decryption: "none" },
        streamSettings: { network: "ws", security: "none", wsSettings: { path: t.path, headers: {} } },
        sniffing,
      });
    } else if (t.proto === "vmess") {
      inbounds.push({
        tag,
        listen: "127.0.0.1",
        port: t.port,
        protocol: "vmess",
        settings: { clients: [] },
        streamSettings: { network: "ws", security: "none", wsSettings: { path: t.path, headers: {} } },
        sniffing,
      });
    } else if (t.proto === "trojan") {
      inbounds.push({
        tag,
        listen: "127.0.0.1",
        port: t.port,
        protocol: "trojan",
        settings: { clients: [], fallbacks: [] },
        streamSettings: { network: "ws", security: "none", wsSettings: { path: t.path, headers: {} } },
        sniffing,
      });
    } else if (t.proto === "shadowsocks") {
      inbounds.push({
        tag,
        listen: "127.0.0.1",
        port: t.port,
        protocol: "shadowsocks",
        settings: { clients: [], network: "tcp,udp" },
        sniffing,
      });
    }
  }
  if (!inbounds.length) {
    inbounds.push({
      tag: "Shadowsocks TCP",
      listen: "127.0.0.1",
      port: TUNNELS[0].port,
      protocol: "shadowsocks",
      settings: { clients: [], network: "tcp,udp" },
    });
  }

  const cfg = {
    log: { loglevel: "warning" },
    routing: { rules: [{ ip: ["geoip:private"], outboundTag: "BLOCK", type: "field" }] },
    inbounds,
    outbounds: [
      { protocol: "freedom", tag: "DIRECT" },
      { protocol: "blackhole", tag: "BLOCK" },
    ],
  };
  fs.writeFileSync(XRAY_JSON, JSON.stringify(cfg, null, 2));
  ok(`xray config written: ${XRAY_JSON}`);
}

/* --------------------------------------------------- python dependencies */

// packages whose pinned version may have no wheel for a newer interpreter
const COMPILED = new Set([
  "grpcio", "grpcio-tools", "cryptography", "cffi", "pydantic", "pydantic-core",
  "psutil", "httptools", "uvloop", "websockets", "markupsafe", "pyyaml",
  "greenlet", "sqlalchemy", "anyio", "orjson",
]);
// build-time only, never needed at runtime (and ~30 MB)
const DROPPED = new Set(["grpcio-tools"]);
// NEVER relax: bcrypt 4.1+ rejects secrets longer than 72 bytes while passlib
// 1.7.4 self-tests with a 255-byte one, which breaks every admin password.
const KEEP_PINNED = { bcrypt: "bcrypt==4.0.1" };

function prepareRequirements(minor) {
  const src = path.join(APP, "requirements.txt");
  if (!fs.existsSync(src)) throw new Error("requirements.txt not found in the Marzban source");
  // setuptools >= 81 dropped pkg_resources, which Marzban's pinned APScheduler
  // imports at start-up; python 12+ no longer seeds a venv with setuptools.
  // protobuf normally arrives with grpcio-tools, which we drop.
  const lines = ["setuptools<81", "wheel", "protobuf>=4.25,<6"];
  for (const raw of fs.readFileSync(src, "utf8").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const name = line.split("==")[0].split("[")[0].split(";")[0].trim().toLowerCase();
    if (DROPPED.has(name)) continue;
    if (KEEP_PINNED[name]) {
      if (!lines.includes(KEEP_PINNED[name])) lines.push(KEEP_PINNED[name]);
      continue;
    }
    if (minor >= 13 && COMPILED.has(name) && line.includes("==")) line = name;
    lines.push(line);
  }
  fs.writeFileSync(REQ_FILE, lines.join("\n") + "\n");
  ok(`prepared ${lines.length} pip requirements`);
  return REQ_FILE;
}

const PROBE = "import fastapi, sqlalchemy, uvicorn, grpc, pkg_resources";

async function installDependencies(base) {
  const venvPy = ["bin/python", "bin/python3"]
    .map((p) => path.join(VENV, p))
    .find((p) => fs.existsSync(p));

  if (venvPy && process.env.MARZBAN_FORCE_SETUP !== "1") {
    const r = await pyEval(venvPy, PROBE, { timeout: 120000 });
    if (r.code === 0) {
      ok("python dependencies already installed");
      return venvPy;
    }
  }
  if (fs.existsSync(PYLIBS) && process.env.MARZBAN_FORCE_SETUP !== "1") {
    const r = await pyEval(base.py, PROBE, { env: { PYTHONPATH: PYLIBS }, timeout: 120000 });
    if (r.code === 0) {
      ok("python dependencies already installed (pylibs)");
      return base.py;
    }
  }

  const req = prepareRequirements(base.version ? base.version.minor : 12);

  step("creating the virtualenv …");
  const venv = await run(base.py, ["-m", "venv", VENV], {
    timeout: 600000,
    show: ["Error", "error", "Traceback"],
  });
  const vpy = ["bin/python", "bin/python3"].map((p) => path.join(VENV, p)).find((p) => fs.existsSync(p));

  if (venv.code === 0 && vpy) {
    await run(vpy, ["-m", "pip", "install", "--quiet", "--upgrade", "pip", "setuptools", "wheel"], {
      timeout: 900000,
      show: ["ERROR", "error"],
    });
    ok("virtualenv ready");
    step("installing Marzban dependencies (first boot: a few minutes) …");
    const pip = await run(
      vpy,
      ["-m", "pip", "install", "--no-cache-dir", "--no-compile",
       "--disable-pip-version-check", "--prefer-binary", "-r", req],
      {
        timeout: 3600000,
        show: ["Collecting", "Installing", "Successfully", "ERROR", "error:", "Failed", "Retrying"],
      }
    );
    if (pip.code === 0) {
      ok("dependencies installed");
      return vpy;
    }
    warn(`pip install failed (code ${pip.code}) — retrying into a target directory`);
  }

  step("installing dependencies with `pip --target` …");
  fs.mkdirSync(PYLIBS, { recursive: true });
  const pip2 = await run(
    base.py,
    ["-m", "pip", "install", "--no-cache-dir", "--no-compile",
     "--disable-pip-version-check", "--prefer-binary", "--target", PYLIBS, "-r", req],
    { timeout: 3600000, show: ["Collecting", "Installing", "Successfully", "ERROR", "error:", "Failed"] }
  );
  if (pip2.code !== 0) throw new Error(`could not install Marzban dependencies (pip exit ${pip2.code})`);
  ok("dependencies installed into pylibs");
  return base.py;
}

/* --------------------------------------------------------- panel runtime */

function panelEnv(extra) {
  const host = (process.env.MARZBAN_PUBLIC_HOST || "").trim();
  const env = {
    UVICORN_HOST: "127.0.0.1",
    UVICORN_PORT: String(PANEL_PORT),
    UVICORN_UDS: "",
    SQLALCHEMY_DATABASE_URL: `sqlite:///${DB_FILE}`,
    XRAY_JSON: XRAY_JSON,
    XRAY_EXECUTABLE_PATH: path.join(XRAY_DIR, "xray"),
    XRAY_ASSETS_PATH: XRAY_DIR,
    XRAY_SUBSCRIPTION_PATH: process.env.XRAY_SUBSCRIPTION_PATH || "sub",
    DOCS: "False",
    DEBUG: "False",
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPATH: fs.existsSync(PYLIBS) ? PYLIBS : "",
    TZ: process.env.TZ || "UTC",
    // uvicorn + APScheduler + grpc means several threads, and glibc then keeps
    // one malloc arena per thread. On a 308 MB plan that fragmentation is
    // expensive, so cap it (only affects processes we spawn).
    MALLOC_ARENA_MAX: "1",
  };
  if (host) {
    const scheme = host.startsWith("https") ? "https" : "http";
    const clean = host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    env.XRAY_SUBSCRIPTION_URL_PREFIX = `${scheme}://${clean}`;
  }
  return { ...env, ...(extra || {}) };
}

function writeEnvFile() {
  const body = Object.entries(panelEnv())
    .filter(([, v]) => v !== "" && v !== null && v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k} = "${v}"`)
    .join("\n");
  fs.writeFileSync(
    path.join(APP, ".env"),
    "# generated by marzban-katabump — edit freely, then restart the server\n" + body + "\n"
  );
}

async function migrate(py) {
  step("running database migrations …");
  const r = await run(py, ["-m", "alembic", "upgrade", "head"], {
    cwd: APP,
    env: panelEnv(),
    timeout: 900000,
    show: ["Running", "ERROR", "error", "Traceback", "FAILED"],
  });
  if (r.code !== 0) throw new Error("alembic migration failed — see the log above");
  ok("database ready");
}

async function createAdmin(py, user, password, force) {
  const env = panelEnv({ MARZBAN_ADMIN_PASSWORD: password });
  if (fs.existsSync(DB_FILE) && !force) {
    const r = await run(py, ["marzban-cli.py", "admin", "list"], {
      cwd: APP,
      env,
      timeout: 300000,
      show: ["Username", "admin", "ERROR"],
    });
    if (r.code === 0 && r.out.includes(user)) {
      ok(`admin "${user}" already exists`);
      return;
    }
  }
  step("creating the panel administrator …");
  const r = await run(
    py,
    ["marzban-cli.py", "admin", "create", "--username", user, "--sudo",
     "--telegram-id", "", "--discord-webhook", ""],
    { cwd: APP, env, timeout: 300000, show: ["Admin", "already", "ERROR", "error", "Traceback"] }
  );
  if (r.code !== 0 && !r.out.includes("already exists")) {
    throw new Error("could not create the admin user — see the log above");
  }
  ok(`admin "${user}" ready`);
}

/* -------------------------------------------------- process supervision */

let PANEL_PROC = null;

function killOrphans() {
  /** A panel killed outright leaves its xray-core behind; two of them would
   *  double the memory bill we cannot afford on the 308 MB free plan. */
  const marker = BASE;
  const me = process.pid;
  const victims = [];
  let pids = [];
  try {
    pids = fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch (_) {
    return;
  }
  for (const pid of pids) {
    if (Number(pid) === me) continue;
    let cmd = "";
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch (_) {
      continue;
    }
    if (cmd.includes(marker)) victims.push(Number(pid));
  }
  if (!victims.length) return;
  for (const pid of victims) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (_) {}
  }
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    /* give them a moment to exit cleanly */
    let alive = 0;
    for (const pid of victims) {
      try {
        process.kill(pid, 0);
        alive++;
      } catch (_) {}
    }
    if (!alive) break;
    const t = Date.now();
    while (Date.now() - t < 100); // 100 ms busy slice
  }
  for (const pid of victims) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (_) {}
  }
  warn(`cleaned up ${victims.length} leftover process(es) from the previous run`);
}

function startPanel(py) {
  killOrphans();
  const env = { ...process.env, ...panelEnv() };
  if (!fs.existsSync(PYLIBS)) delete env.PYTHONPATH;
  log(`starting Marzban on 127.0.0.1:${PANEL_PORT}`);
  const child = spawn(py, ["main.py"], { cwd: APP, env, stdio: ["ignore", "pipe", "pipe"] });
  PANEL_PROC = child;
  const pipe = (stream) => {
    let acc = "";
    stream.setEncoding("utf8");
    stream.on("data", (c) => {
      acc += c;
      let i;
      while ((i = acc.indexOf("\n")) >= 0) {
        const line = acc.slice(0, i).replace(/\s+$/, "");
        acc = acc.slice(i + 1);
        if (line) console.log("[panel] " + line.slice(0, 300));
      }
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", () => {
    /* the watchdog notices and restarts */
  });
  return child;
}

function portOpen(port, timeout = 1200) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: "127.0.0.1", port });
    const done = (v) => {
      try {
        s.destroy();
      } catch (_) {}
      resolve(v);
    };
    s.setTimeout(timeout);
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
  });
}

async function waitForPanel(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(PANEL_PORT, 1500)) return true;
    if (PANEL_PROC && PANEL_PROC.exitCode !== null) return false;
    await sleep(1000);
  }
  return false;
}

/* --------------------------------------------------- Marzban API (seeding) */

function api(method, urlPath, { token, json: body, form } = {}) {
  return new Promise((resolve) => {
    let data = null;
    const headers = { "User-Agent": UA };
    if (body !== undefined) {
      data = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(data);
    }
    if (form !== undefined) {
      data = new URLSearchParams(form).toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(data);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request(
      { host: "127.0.0.1", port: PANEL_PORT, path: urlPath, method, headers, timeout: 25000 },
      (res) => {
        let out = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (out += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null });
          } catch (_) {
            resolve({ status: res.statusCode, body: out });
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ status: 0, body: String(e.message) }));
    if (data) req.write(data);
    req.end();
  });
}

async function login(user, password) {
  const r = await api("POST", "/api/admin/token", {
    form: {
      grant_type: "password",
      username: user,
      password,
      scope: "",
      client_id: "",
      client_secret: "",
    },
  });
  if (r.body && r.body.access_token) return r.body.access_token;
  warn(`API login failed (${r.status}): ${String(r.body).slice(0, 200)}`);
  return null;
}

async function configureHosts(token) {
  let host = (process.env.MARZBAN_PUBLIC_HOST || "").trim();
  if (!host) return;
  host = host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  let address, publicPort;
  if (host.includes(":")) {
    const i = host.lastIndexOf(":");
    address = host.slice(0, i);
    publicPort = int(host.slice(i + 1), PUBLIC_PORT);
  } else {
    address = host;
    publicPort = PUBLIC_PORT;
  }

  const res = await api("GET", "/api/hosts", { token });
  if (!res.body || typeof res.body !== "object") {
    warn(`could not read the inbound hosts (${res.status})`);
    return;
  }

  const stillDefault = (h) => {
    const a = String((h && h.address) || "").trim();
    return !a || a.includes("{") || ["server_ip", "localhost", "127.0.0.1"].includes(a.toLowerCase());
  };

  let changed = false;
  for (const tag of Object.keys(res.body)) {
    if (!tag.toUpperCase().includes("KATABUMP")) continue;
    const existing = res.body[tag] || [];
    const configured = existing.filter((h) => !stillDefault(h));
    if (configured.length) {
      // the admin filled this in by hand — only touch it when it is our own
      // address behind a public port that changed
      const alreadyRight = configured.some((h) => h.address === address && h.port === publicPort);
      if (alreadyRight) continue;
      if (process.env.MARZBAN_FORCE_HOSTS !== "1") continue;
    }
    const digits = tag.replace(/\D/g, "");
    const tunnel = TUNNELS.find((t) => String(t.port) === digits) || TUNNELS[0];
    const put = await api("PUT", "/api/hosts", {
      token,
      json: {
        [tag]: [
          {
            remark: "katabump-public",
            address,
            port: publicPort,
            path: tunnel.path,
            security: "inbound_default",
            alpn: "",
            fingerprint: "",
            allowinsecure: false,
            is_disabled: false,
            mux_enable: false,
          },
        ],
      },
    });
    if (put.status >= 200 && put.status < 300) {
      ok(`subscription links for "${tag}" now point at ${address}:${publicPort}`);
      changed = true;
    } else {
      warn(`could not set the host for "${tag}" (${put.status}): ${String(put.body).slice(0, 160)}`);
    }
  }
  if (!changed) log("hosts already configured");
}

/* ------------------------------------------- the public-port multiplexer */

const STARTING_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5"><title>Marzban — starting</title>
<style>
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1020;color:#e6e9f2;
      font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
 .card{max-width:560px;padding:32px 36px;border:1px solid #1f2a44;border-radius:16px;background:#111832}
 h1{margin:0 0 8px;font-size:20px} code{background:#0b1020;padding:2px 6px;border-radius:6px}
 .bar{height:6px;border-radius:99px;background:#1f2a44;overflow:hidden;margin:18px 0 6px}
 .bar i{display:block;height:100%;width:40%;background:linear-gradient(90deg,#22d3ee,#818cf8);
        animation:sl 1.4s ease-in-out infinite}
 @keyframes sl{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
</style></head><body><div class="card">
<h1>Marzban is starting&nbsp;…</h1>
<p>Step: <code>__STEP__</code></p>
<div class="bar"><i></i></div>
<p style="color:#8b97b8;font-size:13px">
The first boot downloads Marzban, Xray-core and the Python packages, so it can take
several minutes. This page refreshes itself every 5 seconds.
</p></div></body></html>`;

const HEAD_END = Buffer.from("\r\n\r\n");

function parseRequestLine(buf) {
  const end = buf.indexOf("\r\n");
  const line = (end >= 0 ? buf.subarray(0, end) : buf).toString("latin1");
  const parts = line.split(" ");
  return { method: parts[0] || "GET", target: parts[1] || "/", version: parts[2] || "HTTP/1.1" };
}

function withForwarded(buf, ip) {
  const i = buf.indexOf("\r\n");
  if (i < 0) return buf;
  const extra = Buffer.from(`X-Forwarded-For: ${ip}\r\nX-Real-IP: ${ip}\r\nX-Forwarded-Proto: http\r\n`);
  return Buffer.concat([buf.subarray(0, i + 2), extra, buf.subarray(i + 2)]);
}

function writeResponse(socket, status, body, ctype) {
  try {
    socket.write(
      `HTTP/1.1 ${status}\r\nContent-Type: ${ctype}\r\nContent-Length: ${Buffer.byteLength(
        body
      )}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n`
    );
    socket.end(body);
  } catch (_) {}
}

function startProxy() {
  const server = net.createServer({ noDelay: true }, (client) => {
    client.setNoDelay(true);
    let buf = Buffer.alloc(0);
    let routed = false;

    client.on("error", () => {});
    client.on("end", () => {
      if (!routed) client.destroy();
    });

    client.on("data", (chunk) => {
      if (routed) return;
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const idx = buf.indexOf(HEAD_END);
      if (idx < 0) {
        if (buf.length > 65536) client.destroy();
        return;
      }
      routed = true;
      client.removeAllListeners("data");
      route(client, buf, idx);
    });
  });

  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      err(`cannot listen on the public port ${PUBLIC_PORT}: ${e.message}`);
      err("set SERVER_PORT (or PORT) to the port KataBump assigned to your server");
      process.exit(1);
    }
    err(`public port error: ${e.message}`);
  });

  return new Promise((resolve) => {
    server.listen(PUBLIC_PORT, "0.0.0.0", () => resolve(server));
  });
}

function route(client, buf, headEnd) {
  const head = buf.subarray(0, headEnd + 4);
  const rest = buf.subarray(headEnd + 4);
  const { method, target } = parseRequestLine(head);
  const urlPath = target.split("?")[0];
  const ip = (client.remoteAddress || "").replace(/^::ffff:/, "") || "unknown";

  if (urlPath === STATUS_PATH) {
    const payload = JSON.stringify(
      {
        wrapper: WRAPPER,
        marzban: MARZBAN_VERSION,
        publicPort: PUBLIC_PORT,
        panelPort: PANEL_PORT,
        panelUp: STATE.panelUp,
        step: STATE.step,
        error: STATE.error,
        tunnels: TUNNELS,
        data: DATA,
      },
      null,
      2
    );
    return writeResponse(client, "200 OK", payload, "application/json; charset=utf-8");
  }

  const { port } = routePort(urlPath);

  if (port === PANEL_PORT && !STATE.panelUp) {
    const page = STARTING_PAGE.replace("__STEP__", STATE.step);
    if (method === "GET" || method === "HEAD") {
      return writeResponse(client, "503 Service Unavailable", page, "text/html; charset=utf-8");
    }
    return writeResponse(
      client,
      "503 Service Unavailable",
      '{"detail":"panel is still starting"}',
      "application/json"
    );
  }

  const upstream = net.createConnection({ host: "127.0.0.1", port }, () => {
    upstream.setNoDelay(true);
    upstream.write(withForwarded(head, ip));
    if (rest.length) upstream.write(rest);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  upstream.on("error", () => {
    writeResponse(client, "502 Bad Gateway", `upstream 127.0.0.1:${port} unreachable`, "text/plain");
  });
  client.on("error", () => upstream.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
}

/* ------------------------------------------------------------------ banner */

function writeCredFile(user, password) {
  const host = process.env.MARZBAN_PUBLIC_HOST || "<server-address>";
  const lines = [
    "Marzban — KataBump Edition",
    "==========================",
    `panel    : http://${host}/`,
    `dashboard: http://${host}/dashboard/`,
    `username : ${user}`,
    `password : ${password}`,
    "",
    `database : ${DB_FILE}`,
    `source   : ${APP}`,
    `internal : http://127.0.0.1:${PANEL_PORT}  (proxied on the public port)`,
    "",
    ...TUNNELS.map((t) => `tunnel   : ${t.proto} ${t.path} -> 127.0.0.1:${t.port}`),
    "",
    `xray config: ${XRAY_JSON}`,
    "",
  ];
  try {
    fs.writeFileSync(CRED_FILE, lines.join("\n"));
  } catch (_) {}
}

function banner(user, password) {
  const host = process.env.MARZBAN_PUBLIC_HOST || "<server-address>";
  const bar = paint("1", "  ──────────────────────────────────────────────────────");
  console.log("");
  console.log(bar);
  console.log(`  ${paint("1", "Marzban")} ${MARZBAN_VERSION} — KataBump Edition ${paint("2", "(" + WRAPPER + ")")}`);
  console.log(bar);
  console.log(`   panel     ${paint("1", "http://" + host + "/")}`);
  console.log(`   dashboard ${paint("1", "http://" + host + "/dashboard/")}`);
  console.log(`   user      ${user}`);
  console.log(`   pass      ${paint("1", password)}`);
  if (TUNNELS.length) {
    console.log("   tunnels   " + TUNNELS.map((t) => `${t.proto} ${t.path} → 127.0.0.1:${t.port}`).join(", "));
  }
  console.log(`   data      ${DATA}`);
  console.log(bar);
  console.log(`   ${paint("2", "credentials are also saved to " + CRED_FILE)}`);
  console.log(`   ${paint("2", "status json: http://" + host + STATUS_PATH)}`);
  console.log(`   ${paint("33", "KataBump free servers must be renewed every 4 days.")}`);
  console.log(`   ${paint("33", "Only the public port is reachable — xray inbounds are")}`);
  console.log(`   ${paint("33", "proxied through the tunnel paths above.")}`);
  console.log("");
}

/* --------------------------------------------------------------- bootstrap */

async function bootstrap() {
  ensureDirs();
  const base = await findPython();
  await installMarzbanSource();
  releaseMemory();
  await installXray(base.py);
  releaseMemory();
  writeXrayConfig();
  const py = await installDependencies(base);
  releaseMemory();
  writeEnvFile();
  await migrate(py);
  releaseMemory();

  const saved = readState();
  const user = (process.env.ADMIN_USER || "admin").trim() || "admin";
  const password = process.env.ADMIN_PASS || saved.admin_pass || randomToken(12);
  if (!process.env.ADMIN_PASS && !saved.admin_pass) log("generated a random admin password");

  await createAdmin(py, user, password, process.env.FORCE_ADMIN === "1");
  saveState({
    admin_user: user,
    admin_pass: password,
    marzban: MARZBAN_VERSION,
    python: base.py,
    last_boot: new Date().toISOString().slice(0, 19).replace("T", " "),
  });
  writeCredFile(user, password);
  return { py, user, password };
}

/* --------------------------------------------------------------- watchdog */

function watchdog(py) {
  setInterval(async () => {
    // a cold boot allocates a lot of transient memory; nudge V8 to hand it back
    releaseMemory();
    if (!PANEL_PROC) return;
    if (PANEL_PROC.exitCode === null && !PANEL_PROC.killed) {
      if (!STATE.panelUp && (await portOpen(PANEL_PORT))) STATE.panelUp = true;
      return;
    }
    STATE.panelUp = false;
    err(`Marzban exited (code ${PANEL_PROC.exitCode}) — restarting in 5s`);
    await sleep(5000);
    try {
      startPanel(py);
      STATE.panelUp = await waitForPanel(180000);
    } catch (e) {
      err("could not restart Marzban: " + e.message);
    }
  }, 20000).unref();
}

/* ---------------------------------------------------------------- selftest */

async function selfTest() {
  let pass = 0;
  let fail = 0;
  const check = (name, cond, extra) => {
    if (cond) {
      pass++;
      ok(name);
    } else {
      fail++;
      err(name + (extra ? " — " + extra : ""));
    }
  };

  console.log("\nMarzban KataBump self-test\n");

  const base = await findPython();
  check(`python ${base.version.full} (${base.portable ? "portable" : base.py})`, usable(base.version));
  check("public port parsed", PUBLIC_PORT > 0 && PUBLIC_PORT < 65536, String(PUBLIC_PORT));
  check("internal port differs from public", PANEL_PORT !== PUBLIC_PORT);
  check("tunnels parsed", TUNNELS.length > 0, JSON.stringify(TUNNELS));
  check("tunnel path routes to xray", routePort(TUNNELS[0].path).port === TUNNELS[0].port);
  check("panel path routes to marzban", routePort("/api/admin/token").port === PANEL_PORT);

  try {
    const res = await request(
      `https://codeload.github.com/${REPO}/tar.gz/refs/tags/${MARZBAN_VERSION}`,
      { method: "HEAD", timeout: 30000 }
    );
    res.resume();
    check("marzban release reachable", res.statusCode === 200, "HTTP " + res.statusCode);
  } catch (e) {
    check("marzban release reachable", false, e.message);
  }

  try {
    const res = await request(
      "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip",
      { method: "HEAD", timeout: 30000 }
    );
    res.resume();
    check("xray-core reachable", res.statusCode < 400, "HTTP " + res.statusCode);
  } catch (e) {
    check("xray-core reachable", false, e.message);
  }

  ensureDirs();
  writeXrayConfig();
  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(XRAY_JSON, "utf8"));
  } catch (_) {}
  check("xray config has inbounds", !!cfg && Array.isArray(cfg.inbounds) && cfg.inbounds.length > 0);
  check("xray config has outbounds", !!cfg && Array.isArray(cfg.outbounds) && cfg.outbounds.length > 0);
  check(
    "all inbounds tagged",
    !!cfg && cfg.inbounds.every((i) => i.tag && !String(i.tag).includes(","))
  );

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  return fail === 0 ? 0 : 1;
}

/* -------------------------------------------------------------------- main */

async function main() {
  if (process.env.SELFTEST === "1") {
    process.exit(await selfTest());
  }

  log(`${WRAPPER} — node ${process.version}`);
  log(
    `public port ${PUBLIC_PORT} · panel 127.0.0.1:${PANEL_PORT} · tunnels ` +
      TUNNELS.map((t) => `${t.proto}:${t.path}→${t.port}`).join(", ")
  );

  await startProxy();
  log(`public port ${PUBLIC_PORT} open — multiplexing panel + tunnels`);

  let booted;
  try {
    booted = await bootstrap();
  } catch (e) {
    STATE.error = e.message;
    err("bootstrap failed: " + e.message);
    // keep the port open so the error is visible on /_kb/status
    return;
  }

  step("starting Marzban …");
  startPanel(booted.py);
  STATE.panelUp = await waitForPanel(240000);
  if (!STATE.panelUp) {
    STATE.error = "Marzban did not open its port in time";
    err(STATE.error);
    return;
  }
  STATE.step = "ready";
  ok("Marzban is up");

  const token = await login(booted.user, booted.password);
  if (token) {
    ok("panel API is answering");
    await configureHosts(token);
  }

  // the first boot churns through a lot of short-lived objects — give V8 a
  // few chances to release what it can before we settle down
  (async () => {
    for (let i = 0; i < 4; i++) {
      await sleep(3000);
      releaseMemory();
    }
  })();

  banner(booted.user, booted.password);
  watchdog(booted.py);
}

function shutdown(sig) {
  log(`got ${sig} — shutting down`);
  if (PANEL_PROC && PANEL_PROC.exitCode === null) {
    try {
      PANEL_PROC.kill("SIGTERM");
    } catch (_) {}
    setTimeout(() => {
      try {
        PANEL_PROC.kill("SIGKILL");
      } catch (_) {}
      process.exit(0);
    }, 5000).unref();
  } else {
    process.exit(0);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch((e) => {
  err("fatal: " + (e && e.stack ? e.stack : e));
  process.exit(1);
});
