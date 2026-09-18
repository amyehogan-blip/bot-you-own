// ============================================================================
//  THE ALLOWLIST — "in the list → able to do things". Access mode "allow".
//
//  In plain English:
//   · The owner adds email addresses. A bot in "allow" mode lets a visitor in
//     only if the address they joined with is on the list. Two lists: one PER
//     BOT (scope = the bot id) and one for EVERY bot (scope = "*"). Either one
//     is enough.
//   · The list is encrypted at rest. Every row keeps two things about an email:
//       email_hmac  a keyed hash (HMAC-SHA256) — the BLIND INDEX. Checking one
//                   address is one indexed lookup; the list is never decrypted
//                   to answer "is x on it?". Without the key the hash says nothing.
//       email_enc   the address itself, AES-256-GCM, so the owner can SEE who
//                   is on the list (Under the hood → Settings → Allowlist).
//     Both keys come from ONE secret, ALLOWLIST_KEY (32 random bytes, base64):
//        printf "$(openssl rand -base64 32)" | npx wrangler secret put ALLOWLIST_KEY
//     Two sub-keys are derived from it (HMAC of the labels "hmac" / "aes"), so
//     the hash key and the cipher key are never the same bytes.
//   · No ALLOWLIST_KEY → allow mode FAILS CLOSED: nobody is on the list, every
//     check refuses, the log says why once. (Rotating the key empties the list
//     for the same reason: the old hashes no longer match.)
//   · Nothing here sends email. The list is who the owner typed in, nothing more.
// ============================================================================

const TABLE = `CREATE TABLE IF NOT EXISTS allowlist (scope TEXT NOT NULL, email_hmac TEXT NOT NULL, email_enc TEXT NOT NULL, added_at TEXT NOT NULL, added_by TEXT, expires_at TEXT, PRIMARY KEY (scope, email_hmac))`;
export const GLOBAL_SCOPE = "*";
const EMAIL_SHAPE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
export const cleanEmail = (e) => { const s = String(e || "").trim().toLowerCase().slice(0, 254); return EMAIL_SHAPE.test(s) ? s : ""; };
export const cleanScope = (s) => { s = String(s || "").trim().toLowerCase(); return s === GLOBAL_SCOPE ? s : /^[a-z0-9-]{1,40}$/.test(s) ? s : ""; };

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(String(s || "")), (c) => c.charCodeAt(0));

let WARNED = false;
export const hasKey = (env) => keyBytes(env) !== null;
function keyBytes(env) {
  try {
    const raw = unb64(String(env.ALLOWLIST_KEY || "").trim());
    if (raw.length >= 32) return raw;
  } catch {}
  return null;
}

// The two sub-keys, derived once per isolate from the one secret.
let KEYS = null, KEYS_FOR = "";
async function keys(env) {
  const raw = keyBytes(env);
  if (!raw) return null;
  const tag = b64(raw.slice(0, 8));                                       // enough to notice a rotated secret
  if (KEYS && KEYS_FOR === tag) return KEYS;
  const master = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sub = async (label) => new Uint8Array(await crypto.subtle.sign("HMAC", master, enc.encode(`bot-you-own/allowlist/${label}`)));
  const hmac = await crypto.subtle.importKey("raw", await sub("hmac"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const aes = await crypto.subtle.importKey("raw", await sub("aes"), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  KEYS = { hmac, aes }; KEYS_FOR = tag;
  return KEYS;
}
async function blind(k, email) { return hex(await crypto.subtle.sign("HMAC", k.hmac, enc.encode(email))); }
async function seal(k, email) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k.aes, enc.encode(email));
  return b64(iv) + "." + b64(ct);
}
async function unseal(k, blob) {
  const [iv, ct] = String(blob || "").split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, k.aes, unb64(ct));
  return new TextDecoder().decode(pt);
}

let SCHEMA_OK = false;
// A list made before v3.11 has no expires_at column, and SQLite has no ADD COLUMN
// IF NOT EXISTS — so look, then add. Kept here rather than imported from expiry.js
// on purpose: expiry.js reads this file's blind index, and one of the two has to
// not depend on the other.
async function ensure(env) {
  if (SCHEMA_OK) return;
  await env.DB.prepare(TABLE).run();
  try {
    const info = (await env.DB.prepare(`PRAGMA table_info(allowlist)`).all()).results || [];
    if (info.length && !info.some((c) => c.name === "expires_at")) await env.DB.prepare(`ALTER TABLE allowlist ADD COLUMN expires_at TEXT`).run();
  } catch (err) { console.warn("could not add allowlist.expires_at — invitations stay unlimited", err?.message || err); }
  SCHEMA_OK = true;
}

// The blind index for one address, for callers outside this file. Engine/worker/expiry.js
// needs it to find a person's list row WITHOUT ever handling their email in the clear —
// the whole point of the blind index. Returns "" when the key isn't set.
export async function blindFor(env, email) {
  try {
    email = cleanEmail(email);
    if (!email) return "";
    const k = await keys(env);
    return k ? await blind(k, email) : "";
  } catch { return ""; }
}

// --- THE CHECK. { ok, reason?, scope? }. Fails closed: no key, no DB, an error → not allowed.
export async function isAllowed(env, bot, email) {
  try {
    email = cleanEmail(email);
    if (!email) return { ok: false, reason: "Please enter your email address to start." };
    if (!env.DB) return { ok: false, reason: "The allowlist needs the D1 database (wrangler.jsonc → d1_databases)." };
    const k = await keys(env);
    if (!k) {
      if (!WARNED) { WARNED = true; console.warn("access mode \"allow\" is in use but ALLOWLIST_KEY is not set — nobody is on the list, every visitor is refused (docs/DEPLOY.md → B2c)"); }
      return { ok: false, reason: "This bot is for invited people, and the owner hasn't finished setting the list up." };
    }
    await ensure(env);
    const h = await blind(k, email);
    const scope = cleanScope(bot);
    const row = await env.DB.prepare(`SELECT scope FROM allowlist WHERE email_hmac = ? AND scope IN (?, ?) LIMIT 1`).bind(h, scope || "-", GLOBAL_SCOPE).first();
    if (!row) return { ok: false, reason: `${email} isn't on the list for this bot. Ask the owner to add it.`, hmac: h };
    // Being ON the list and being IN DATE are two different questions. This one only
    // answers the first; Engine/worker/expiry.js reads expires_at and decides what a
    // lapsed invitation does, because that is configurable (tell / readonly / silent).
    return { ok: true, scope: row.scope, hmac: h };
  } catch (err) {
    console.error("allowlist check failed — refusing", err?.message || err);
    return { ok: false, reason: "The list couldn't be checked. Nothing was opened." };
  }
}

// --- THE OWNER'S SIDE (admin routes in index.js). ---------------------------------
// `until` is an optional end date for the INVITATION (null = unlimited, the default
// and the old behaviour). Adding someone who is already on the list re-dates them
// rather than being ignored — "add them again with a new date" is how an owner
// naturally extends a cohort, so it must not silently do nothing.
export async function addToList(env, scope, email, who = "admin", until = null) {
  scope = cleanScope(scope); email = cleanEmail(email);
  if (!scope || !email) return { ok: false, status: 400, error: "scope (a bot id or *) and a valid email are required" };
  const k = await keys(env);
  if (!k) return { ok: false, status: 503, error: "ALLOWLIST_KEY is not set", reason: "Set the ALLOWLIST_KEY secret first (docs/DEPLOY.md → B2c). Until then allow mode refuses everyone." };
  await ensure(env);
  const h = await blind(k, email);
  const before = await env.DB.prepare(`SELECT expires_at FROM allowlist WHERE scope = ? AND email_hmac = ?`).bind(scope, h).first();
  await env.DB.prepare(`INSERT INTO allowlist (scope, email_hmac, email_enc, added_at, added_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope, email_hmac) DO UPDATE SET expires_at = excluded.expires_at, added_by = excluded.added_by`)
    .bind(scope, h, await seal(k, email), new Date().toISOString(), String(who).slice(0, 60), until).run();
  return { ok: true, scope, email, until, was: before?.expires_at || null, existed: Boolean(before) };
}
export async function removeFromList(env, scope, email) {
  scope = cleanScope(scope); email = cleanEmail(email);
  if (!scope || !email) return { ok: false, status: 400, error: "scope and email are required" };
  const k = await keys(env);
  if (!k) return { ok: false, status: 503, error: "ALLOWLIST_KEY is not set" };
  await ensure(env);
  const r = await env.DB.prepare(`DELETE FROM allowlist WHERE scope = ? AND email_hmac = ?`).bind(scope, await blind(k, email)).run();
  return { ok: true, scope, email, removed: Number(r?.meta?.changes || 0) };
}
// The list, DECRYPTED, for the owner. A row the key can't open (rotated key) shows as "(unreadable)".
export async function listFor(env, scope) {
  scope = cleanScope(scope);
  if (!scope) return { ok: false, status: 400, error: "which scope?" };
  const k = await keys(env);
  if (!k) return { ok: true, scope, keySet: false, rows: [], reason: "ALLOWLIST_KEY is not set: the list is empty and allow mode refuses everyone." };
  await ensure(env);
  const rows = (await env.DB.prepare(`SELECT email_enc, added_at, added_by, expires_at FROM allowlist WHERE scope = ? ORDER BY added_at`).bind(scope).all()).results || [];
  const out = [];
  for (const r of rows) { let email = "(unreadable — the key changed)"; try { email = await unseal(k, r.email_enc); } catch {} out.push({ email, added_at: r.added_at, added_by: r.added_by, expires_at: r.expires_at || null }); }
  return { ok: true, scope, keySet: true, rows: out };
}
// How many are on each list — for the Settings table.
export async function listCounts(env) {
  if (!env.DB) return {};
  try {
    await ensure(env);
    const rows = (await env.DB.prepare(`SELECT scope, COUNT(*) n FROM allowlist GROUP BY scope`).all()).results || [];
    return Object.fromEntries(rows.map((r) => [r.scope, Number(r.n)]));
  } catch { return {}; }
}
