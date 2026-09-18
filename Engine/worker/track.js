// ============================================================================
//  FOOD LOG — /food. A photo food log a coach deploys for their clients.
//
//  Not a chat bot: a page with a camera button. Snap the plate, the vision
//  model names the foods and guesses the numbers, the person fixes the
//  portion with a tap, the day shows a ring and three bars. Also: type a
//  meal, scan a barcode, read a nutrition label, scan a receipt, weigh in,
//  share a household with a spouse. The coach sees every client at /food/coach.
//
//  IDENTITY lives in Engine/identity/ (docs/IDENTITY.md) and is shared by every
//  kind of bot: email + device key, passkeys, Google/Microsoft/Apple, an
//  authenticator code, or the coach's link for a second device. This file only
//  asks "who is this browser?" and keeps the food side of a person (targets).
//  Identity fails CLOSED (unknown device = 401); features fail OPEN (no
//  thumbnail, no barcode database, no model → the page still works, with less).
//
//  A food log is a bot of kind "food" (YourBots/<id>/project.json). It lives at
//  /apps/<id> with its API at /api/apps/<id>/… and the coach at /api/admin/apps/<id>/….
//  /food and /api/food/… are aliases for the bot whose id is "plate" (one release).
//
//  ROUTES (under /api/apps/<id>/, device key in the x-device-key header):
//   GET  config                       what the page needs (coach name, sign-in buttons)
//   POST join {email}                 → { linked, userId } or { linked:false, code, message }
//   GET  me                           who am I, my targets, my household, still pending?
//   POST signin {provider, idToken}   link this device by proving the email (passkeys, codes: /api/id/*)
//   GET/POST targets                  daily kcal + macros (+ unit, name)
//   POST photo (multipart)            photo, thumb, kind=food|barcode|label|receipt, date, correction, mealId
//   POST text {text, date, correction, mealId}
//   POST meal {date, items, source}   · PATCH meal/<id> {items} · DELETE meal/<id>
//   GET  day?date=&user=              · GET week?end=&user=   (user= a household member, read-only)
//   POST barcode {code}               · POST weight {date, value, unit}
//   GET/POST household, POST household/join, POST household/leave
//   GET  receipts · DELETE receipt/<id>
//  Admin (x-admin-token): GET /api/admin/apps/<id>/clients · GET client/<uid> ·
//   GET export.csv · POST link {email, deviceCode} · GET client/<id>/summary?kind=week&end=
//   The day as a conversation, summaries, favourites (v3.10 — Engine/worker/track-day.js):
//   GET chat?date= · POST say {date,text,hour,tz} · GET favourites?hour=&date= · POST repeat {favouriteId|fromDate,date,mult}
//   POST favourite/name {id,name} · DELETE favourite/<id> · GET summary?date=&kind=day|week
//   POST transcribe (multipart "audio") → { text }   the mic: Whisper on Workers AI, never the browser's own
//  Pages: /apps/<id> (the app) · /apps/<id>/coach (the coach view). Both are the
//  static files in Engine/public/food/, served through here per bot.
// ============================================================================

import { json, nowIso, pickDate, addDays, todayUtc, clamp, round1, cleanEmail, readJson, toBase64, randomId } from "./track-common.js";
import { CONFIG } from "../../YourBots/config.js";
import { identify, signInMethods, verifyIdToken } from "../identity/index.js";
import { resolve as resolveExpiry, lapseReply, noticeFor, EXPIRY_BUILT_IN } from "./expiry.js";
import { join as idJoin, userIdFor, userById as idUserById, bindDevice, linkByCode, deviceCount, listDevices, pendingByEmail, touch as idTouch, DEV_PEPPER, pepperOf } from "../identity/devices.js";
import { runVision, PROMPTS, extractJson, sanitiseItems, sanitiseLabel, sanitiseReceipt, totalsOf, imageSize, mergeCorrection } from "./track-vision.js";
import { lookupBarcode, rememberLabel, saveReceipt, listReceipts, deleteReceipt, setWeight, listWeights, importWeights, householdOf, createHousehold, joinHousehold, leaveHousehold, canView } from "./track-extras.js";
import { ensureDaySchema, dayChat, addWords, afterMeal, editedMeal, removedMeal, listFavourites, nameFavourite, forgetFavourite, matchFavourite, repeatMeals, askDay, summaryFor, classifySay, looksLikeFood } from "./track-day.js";

const THUMB_MAX_PX = 256, THUMB_MAX_BYTES = 48 * 1024;
let HONESTY = "Photo estimates are typically within about 30%. Fix the portion when it's off.";   // per bot: project.json → food.honesty

// --- The tables. Created on first use, like the rest of the Worker. ------------
let TRACK_SCHEMA_OK = false;
export async function ensureTrackSchema(env) {
  if (TRACK_SCHEMA_OK || !env.DB) return;
  await env.DB.batch([
    // The food side of a person: targets. Who they ARE (email, devices) is Engine/identity/ (id_users, id_devices …).
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_users (id TEXT PRIMARY KEY, email TEXT, targets_json TEXT, created_at TEXT NOT NULL, last_seen TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_meals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, date TEXT NOT NULL, time TEXT, items_json TEXT NOT NULL, kcal REAL, protein_g REAL, carbs_g REAL, fat_g REAL, thumb TEXT, source TEXT, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_track_meals_day ON track_meals(user_id, date)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_usage (user_id TEXT NOT NULL, date TEXT NOT NULL, photos INTEGER DEFAULT 0, PRIMARY KEY (user_id, date))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_products (code TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_receipts (id TEXT PRIMARY KEY, household_id TEXT, user_id TEXT NOT NULL, store TEXT, date TEXT, total REAL, currency TEXT, items_json TEXT, thumb TEXT, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_track_receipts_h ON track_receipts(household_id, date)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_weights (user_id TEXT NOT NULL, date TEXT NOT NULL, kg REAL NOT NULL, PRIMARY KEY (user_id, date))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_households (id TEXT PRIMARY KEY, name TEXT, code TEXT UNIQUE, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_members (household_id TEXT NOT NULL, user_id TEXT PRIMARY KEY, name TEXT, joined_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_track_members_h ON track_members(household_id)`),
  ]);
  await ensureDaySchema(env);
  TRACK_SCHEMA_OK = true;
}

// --- The router. Called from index.js for one food bot: the app's page, its API, its coach API.
//     `bot` is the resolved project (kind food); api/page/admin are the path prefixes it answers on
//     ("/api/apps/plate/", "/apps/plate", "/api/admin/apps/plate/" — or the /food aliases).
export async function handleTrack(request, env, url, { bot, api, page, admin, isAdmin = false, adminEnabled = false, allowed = async () => true, graceMinutes = 60, expiry: expCfg = EXPIRY_BUILT_IN } = {}) {
  const cfg = foodConfig(bot, env);
  HONESTY = cfg.honesty;
  const p = url.pathname;

  // The pages. /apps/<id> → the app; /apps/<id>/coach → the coach view. Static files in Engine/public/food/.
  if (p === page || p === page + "/") return env.ASSETS.fetch(new Request(`${url.origin}/food/`, { headers: request.headers }));
  if (p.startsWith(page + "/")) return env.ASSETS.fetch(new Request(`${url.origin}/food/${p.slice(page.length + 1)}`, { headers: request.headers }));

  if (p.startsWith(admin)) {
    if (!isAdmin) return json({ error: "admin only" }, adminEnabled ? 401 : 404);
    if (!env.DB) return json({ error: "No D1 database is bound (wrangler.jsonc → d1_databases)." }, 503);
    await ensureTrackSchema(env);
    return handleCoach(request, env, url, cfg, p.slice(admin.length));
  }

  if (p === api + "config") return json({ enabled: true, id: bot.id, name: cfg.name, coachName: cfg.coachName, honesty: cfg.honesty, signIn: cfg.signIn, methods: { passkeys: cfg.methods.passkeys, totp: cfg.methods.totp, providers: cfg.signIn.map((s) => s.provider) }, dailyPhotoLimit: cfg.dailyPhotoLimit, maxPhotoBytes: cfg.maxPhotoBytes, api, page });
  if (!env.DB) return json({ error: "The food log needs the D1 database (wrangler.jsonc → d1_databases)." }, 503);
  await ensureTrackSchema(env);
  if (cfg.pepper === DEV_PEPPER) console.warn("FOODLOG_PEPPER is not set — user ids use the dev pepper. Set it before real people use this: npx wrangler secret put FOODLOG_PEPPER");

  // Who is this browser? Engine/identity/index.js — fails closed.
  const who = await identify(request, env, bot);
  const keyHash = who.keyHash;

  if (p === api + "join") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!(await allowed(env, request))) return json({ error: "rate-limited", reason: "Too many tries. Give it a minute." }, 429);
    if (!keyHash) return json({ error: "no device key", reason: "This browser didn't send a device key. Reload the page." }, 400);
    return join(env, cfg, await readJson(request), keyHash, graceMinutes);
  }

  // Everything below needs a known device. Unknown → 401, no exceptions.
  const me = who.user ? await withProfile(env, who.user) : null;
  if (p === api + "signin") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!(await allowed(env, request))) return json({ error: "rate-limited" }, 429);
    if (!keyHash) return json({ error: "no device key" }, 400);
    return signIn(env, cfg, await readJson(request), keyHash, me);
  }
  // --- IS THIS PERSON STILL IN DATE? (Engine/worker/expiry.js) ------------------
  //     A coaching block ends and the client's log should stop taking new meals.
  //     What that looks like is the owner's choice, the same three words as a chat
  //     bot: tell / readonly / silent. "readonly" is the one that matters here —
  //     a client whose twelve weeks are up can still open their whole history.
  //     The admin is never time-boxed, and every lookup fails open.
  const expiry = isAdmin || !me ? null : await resolveExpiry(env, { bot: bot.id, email: me.email || "", emailHmac: "", keyName: "" }, expCfg);
  const lapsed = Boolean(expiry && expiry.state === "lapsed");
  const readOnly = lapsed && expCfg.onLapse === "readonly";

  if (p === api + "me") {
    if (me) {
      // A lapsed person must be turned away HERE too, not only on the writes below —
      // /me is what the page boots from, so letting it through would open the app as
      // if nothing had happened. "readonly" is the one mode that deliberately says yes:
      // reading their own log is the whole point of it.
      if (lapsed && !readOnly) {
        // Under "silent" we say nothing that confirms the account exists — not even
        // linked:true — which is the difference between "silent" and "tell".
        const quiet = expCfg.onLapse === "silent";
        return json(quiet ? { linked: false, reason: lapseReply(expiry, bot) } : { linked: true, error: "expired", reason: lapseReply(expiry, bot) }, 403);
      }
      return json({ linked: true, ...(await profile(env, me)), access: expiry ? { until: expiry.until, state: expiry.state, days: expiry.days, notice: noticeFor(expiry), readOnly } : null });
    }
    return json(who.pending ? { linked: false, code: who.pending.code, email: who.pending.email, message: PENDING_MESSAGE } : { linked: false }, 401);
  }
  if (!me) return json({ error: "unknown device", reason: "This browser isn't linked to a log. Enter your email to start." }, 401);
  if (lapsed && !readOnly) return json({ error: "expired", reason: lapseReply(expiry, bot) }, 403);
  touch(env, me);

  const sub = p.slice(api.length);
  // readonly: GET still works, so the day, the week and every photo they ever logged
  // are all still there. Anything that changes the log is refused with the same line.
  if (readOnly && request.method !== "GET") return json({ error: "expired", reason: lapseReply(expiry, bot), readOnly: true }, 403);
  const body = request.method === "POST" || request.method === "PATCH" ? await readJson(request.clone()) : {};

  if (sub === "targets") {
    if (request.method === "GET") return json({ targets: me.targets });
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const t = cleanTargets(body.targets || body);
    await env.DB.prepare(`UPDATE track_users SET targets_json = ? WHERE id = ?`).bind(JSON.stringify(t), me.id).run();
    return json({ ok: true, targets: t });
  }
  if (sub === "photo") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!(await allowed(env, request))) return json({ error: "rate-limited", reason: "You're sending photos faster than I can look. Give me a moment." }, 429);
    return photo(request, env, cfg, me);
  }
  if (sub === "text") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!(await allowed(env, request))) return json({ error: "rate-limited", reason: "Give me a moment and try again." }, 429);
    return textMeal(env, cfg, me, body);
  }
  if (sub === "meal" && request.method === "POST") return saveMeal(env, me, body);
  if (sub.startsWith("meal/")) {
    const id = sub.slice(5);
    const row = await env.DB.prepare(`SELECT id, user_id FROM track_meals WHERE id = ?`).bind(id).first();
    if (!row) return json({ error: "no such meal" }, 404);
    if (row.user_id !== me.id) return json({ error: "not yours", reason: "You can look at a household member's day, but only they can change it." }, 403);
    if (request.method === "DELETE") { await removedMeal(env, me, id); await env.DB.prepare(`DELETE FROM track_meals WHERE id = ?`).bind(id).run(); return json({ ok: true }); }
    if (request.method === "PATCH") {
      const items = sanitiseItems(body.items);
      if (!items.length) return json({ error: "no items", reason: "A meal needs at least one food. Delete it instead." }, 400);
      const t = totalsOf(items);
      await env.DB.prepare(`UPDATE track_meals SET items_json = ?, kcal = ?, protein_g = ?, carbs_g = ?, fat_g = ? WHERE id = ?`).bind(JSON.stringify(items), t.kcal, t.protein_g, t.carbs_g, t.fat_g, id).run();
      const meal = await readMeal(env, id);
      const after = await editedMeal(env, me, meal, { tzOffsetMin: body.tz });
      return json({ ok: true, meal, totals: after.totals, favourite: after.favourite });
    }
    return json({ error: "PATCH or DELETE" }, 405);
  }
  if (sub === "day" || sub === "week") {
    const target = String(url.searchParams.get("user") || me.id);
    if (target !== me.id && !(await canView(env, me.id, target))) return json({ error: "not allowed", reason: "You can only see days of people in your household." }, 403);
    const who = target === me.id ? me : await userById(env, me.bot, target);
    if (!who) return json({ error: "no such user" }, 404);
    return json(sub === "day" ? await dayView(env, who, pickDate(url.searchParams.get("date")), { readOnly: target !== me.id }) : await weekView(env, who, pickDate(url.searchParams.get("end"))));
  }
  // --- The day as a conversation (Engine/worker/track-day.js). ---------------------------
  if (sub === "chat") {
    const target = String(url.searchParams.get("user") || me.id);
    if (target !== me.id && !(await canView(env, me.id, target))) return json({ error: "not allowed" }, 403);
    const who = target === me.id ? me : await userById(env, me.bot, target);
    if (!who) return json({ error: "no such user" }, 404);
    return json({ ...(await dayChat(env, who, pickDate(url.searchParams.get("date")))), readOnly: target !== me.id });
  }
  if (sub === "say") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!(await allowed(env, request))) return json({ error: "rate-limited", reason: "Give me a moment and try again." }, 429);
    return say(env, cfg, me, body);
  }
  if (sub === "favourites") return json(await listFavourites(env, me, { hour: url.searchParams.get("hour"), date: pickDate(url.searchParams.get("date")) }));
  if (sub === "transcribe") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!(await allowed(env, request))) return json({ error: "rate-limited", reason: "Give me a moment and try again." }, 429);
    return transcribe(request, env);
  }
  if (sub === "repeat") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const date = pickDate(body.date);
    const r = await repeatMeals(env, me, { favouriteId: body.favouriteId, fromDate: body.fromDate, date, mult: body.mult, insertMeal: (m) => insertMeal(env, me, m) });
    if (!r.ok) return json(r, r.status || 400);
    let totals = null;
    for (const m of r.meals) totals = (await afterMeal(env, me, m, { repeat: true, favouriteName: r.favourite?.name || "", tzOffsetMin: body.tz })).totals;
    return json({ ...r, totals });
  }
  if (sub === "favourite/name") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const r = await nameFavourite(env, me, body.id, body.name); return json(r, r.ok ? 200 : r.status || 400);
  }
  if (sub.startsWith("favourite/") && request.method === "DELETE") return json(await forgetFavourite(env, me, sub.slice(10)));
  if (sub === "summary") {
    const target = String(url.searchParams.get("user") || me.id);
    if (target !== me.id && !(await canView(env, me.id, target))) return json({ error: "not allowed" }, 403);
    const who = target === me.id ? me : await userById(env, me.bot, target);
    if (!who) return json({ error: "no such user" }, 404);
    const kind = url.searchParams.get("kind") === "week" ? "week" : "day";
    if (!(await allowed(env, request))) return json({ error: "rate-limited" }, 429);
    return json(await summaryFor(env, who, { date: pickDate(url.searchParams.get("date")), kind, coachName: cfg.coachName, force: url.searchParams.get("refresh") === "1" }));
  }
  if (sub === "barcode") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const out = await lookupBarcode(env, body.code);
    return json(out, out.ok ? 200 : 404);
  }
  if (sub === "weight/import") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const out = await importWeights(env, me, body.rows);
    return json(out.ok ? { ...out, trend: await listWeights(env, me.id, 0) } : out, out.ok ? 200 : 400);
  }
  if (sub === "weight") {
    // GET ?days=N (default 30; 0 = all of it) — the weight screen asks for the range it shows.
    if (request.method === "GET") return json(await listWeights(env, me.id, url.searchParams.has("days") ? Number(url.searchParams.get("days")) : 30));
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const out = await setWeight(env, me, body);
    if (out.ok && out.unit !== (me.targets?.unit || "kg")) await env.DB.prepare(`UPDATE track_users SET targets_json = ? WHERE id = ?`).bind(JSON.stringify({ ...(me.targets || {}), unit: out.unit }), me.id).run();
    return json(out.ok ? { ...out, trend: await listWeights(env, me.id, 30) } : out, out.ok ? 200 : 400);
  }
  if (sub === "household") {
    if (request.method === "GET") return json({ household: await householdView(env, me) });
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const out = await createHousehold(env, me, body);
    return json(out.ok ? { ok: true, household: await householdView(env, me) } : out, out.ok ? 200 : 400);
  }
  if (sub === "household/join") { const out = await joinHousehold(env, me, body); return json(out.ok ? { ok: true, household: await householdView(env, me) } : out, out.ok ? 200 : 400); }
  if (sub === "household/leave") { return json(await leaveHousehold(env, me)); }
  if (sub === "receipts") { const h = await householdOf(env, me.id); return json(await listReceipts(env, { user: me, householdId: h?.id || null })); }
  if (sub.startsWith("receipt/") && request.method === "DELETE") {
    const h = await householdOf(env, me.id);
    const out = await deleteReceipt(env, { user: me, householdId: h?.id || null, id: sub.slice(8) });
    return json(out, out.ok ? 200 : out.status);
  }
  return json({ error: "not found" }, 404);
}

const PENDING_MESSAGE = "This email is already logging on another device. Use a passkey, sign in, type your authenticator code, or ask your coach to link this device.";

// The bot's food block + the sign-in methods it has on + the pepper. Every value already checked by Engine/worker/projects.js.
function foodConfig(bot, env) {
  const f = bot.food || {};
  const methods = signInMethods(bot, env);
  return { id: bot.id, name: bot.name, model: f.model, maxPhotoBytes: f.maxPhotoBytes, dailyPhotoLimit: f.dailyPhotoLimit, coachName: f.coachName, honesty: f.honesty, signIn: methods.providers, methods, pepper: pepperOf(env) };
}

// --- JOIN: first device creates the log; a second device gets a code instead (Engine/identity/devices.js). ---
async function join(env, cfg, body, keyHash, graceMinutes) {
  const email = cleanEmail(body.email);
  if (!email) return json({ error: "email", reason: "That doesn't look like an email address." }, 400);
  const r = await idJoin(env, cfg.id, { email, keyHash, graceMinutes });
  if (r.linked) return json({ linked: true, ...(await profile(env, await withProfile(env, r.user))), ...(r.fresh ? { fresh: true } : {}) });
  return json({ linked: false, code: r.code, email, message: PENDING_MESSAGE, signIn: cfg.signIn.map((s) => s.provider), methods: { passkeys: cfg.methods.passkeys, totp: cfg.methods.totp } }, 202);
}

// --- SIGN IN: the provider's ID token proves the email; the device is linked. ------
async function signIn(env, cfg, body, keyHash, me) {
  const provider = String(body.provider || "").toLowerCase();
  const conf = cfg.signIn.find((s) => s.provider === provider && s.clientId);
  if (!conf) return json({ error: "provider not configured" }, 404);
  const v = await verifyIdToken(body.idToken, provider, { clientId: conf.clientId });
  if (!v.ok) { console.warn("foodlog signin refused", provider, v.reason); return json({ error: "refused", reason: `Sign-in refused: ${v.reason}.` }, 401); }
  const userId = await userIdFor(v.email, env, cfg.id);
  if (me && me.id !== userId) return json({ error: "different email", reason: "This device is already linked to a different email." }, 409);
  const user = await bindDevice(env, cfg.id, { userId, email: v.email, keyHash, label: `signed in with ${provider}` });
  return json({ linked: true, ...(await profile(env, await withProfile(env, user))) });
}

// The Fix line sends the items on screen as `current`. What the model needs to see of each
// to leave it alone — no ids, no per-100 g table — and a forgiving reader for the field.
const slim = (items) => items.map(({ name, portion, grams, kcal, protein_g, carbs_g, fat_g }) => ({ name, portion, grams, kcal, protein_g, carbs_g, fat_g }));
function listFrom(v) { try { const x = typeof v === "string" ? JSON.parse(v) : v; return Array.isArray(x) ? x : []; } catch { return []; } }

// --- PHOTO: one call to the vision model, four kinds of picture. -----------------------
async function photo(request, env, cfg, me) {
  let form;
  try { form = await request.formData(); } catch { return json({ error: "bad request", reason: "Expected a multipart form with a photo." }, 400); }
  const f = form.get("photo");
  if (!f || typeof f.arrayBuffer !== "function") return json({ error: "no photo", reason: "No photo in the request." }, 400);
  if (f.size > cfg.maxPhotoBytes) return json({ error: "too big", reason: `That photo is ${(f.size / 1048576).toFixed(1)} MB; the limit is ${(cfg.maxPhotoBytes / 1048576).toFixed(0)} MB. The page should have shrunk it — reload and try again.` }, 413);
  const kind = ["food", "barcode", "label", "receipt"].includes(form.get("kind")) ? form.get("kind") : "food";
  const date = pickDate(form.get("date"));
  const correction = String(form.get("correction") || "").trim().slice(0, 200);
  const mealId = String(form.get("mealId") || "").trim();
  // A correction arrives with what's on screen now, so it can't undo an earlier one.
  const current = sanitiseItems(listFrom(form.get("current")), { source: "photo" });
  const revising = kind === "food" && Boolean(correction) && current.length > 0;

  // The daily cap: every vision call counts, whatever kind.
  const used = (await env.DB.prepare(`SELECT photos FROM track_usage WHERE user_id = ? AND date = ?`).bind(me.id, todayUtc()).first())?.photos || 0;
  if (used >= cfg.dailyPhotoLimit) return json({ error: "daily-limit", reason: `That's ${cfg.dailyPhotoLimit} photos today — the daily limit. You can still type a meal.` }, 429);
  await env.DB.prepare(`INSERT INTO track_usage (user_id, date, photos) VALUES (?, ?, 1) ON CONFLICT(user_id, date) DO UPDATE SET photos = photos + 1`).bind(me.id, todayUtc()).run();

  const bytes = await f.arrayBuffer();
  const mime = /^image\/(png|webp)$/.test(f.type) ? f.type : "image/jpeg";
  const thumb = await cleanThumb(form.get("thumb"));

  let out;
  try {
    const prompt = kind === "food" ? (revising ? PROMPTS.revise(slim(current), correction, true) : PROMPTS.food(correction)) : PROMPTS[kind];
    out = await runVision(env, cfg, { image: bytes, mime, prompt, maxTokens: kind === "receipt" ? 1500 : 900 });
  } catch (err) {
    console.error("foodlog vision failed", err?.message || err);
    return json({ error: "model", reason: "The model couldn't look at that just now. Try again, or type the meal." }, 502);
  }
  const parsed = extractJson(out.text);

  if (kind === "food") {
    const fresh = sanitiseItems(parsed?.items, { source: "photo" });
    const items = revising ? mergeCorrection(current, fresh, correction) : fresh;
    if (revising && !fresh.length) return json({ error: "no food", reason: "I couldn't apply that correction. Try naming the food and the amount, like “8 strawberries”." }, 422);
    if (!items.length) return json({ error: "no food", reason: parsed?.notes ? `I couldn't find food in that: ${String(parsed.notes).slice(0, 140)}` : "I couldn't make out any food in that photo. Try closer, with more light — or type it.", raw: out.text.slice(0, 300) }, 422);
    const meal = mealId ? await updateMealItems(env, me, mealId, items) : await insertMeal(env, me, { date, items, source: "photo", thumb });
    if (!meal) return json({ error: "no such meal" }, 404);
    const after = mealId ? await editedMeal(env, me, meal, { tzOffsetMin: form.get("tz") }) : await afterMeal(env, me, meal, { tzOffsetMin: form.get("tz") });
    return json({ ok: true, meal, notes: String(parsed?.notes || "").slice(0, 200), honesty: HONESTY, totals: after.totals });
  }
  if (kind === "barcode") {
    const digits = String(parsed?.digits || "").replace(/\D/g, "");
    const found = digits ? await lookupBarcode(env, digits) : { ok: false, reason: "I couldn't read a barcode in that photo. Get the numbers under the bars sharp, or snap the nutrition label." };
    return json({ ...found, digits }, found.ok ? 200 : 422);
  }
  if (kind === "label") {
    const label = sanitiseLabel(parsed);
    if (!label) return json({ error: "no label", reason: "I couldn't read a nutrition label in that photo. Fill the frame with the label and try again." }, 422);
    const stored = await rememberLabel(env, label);
    return json({ ok: true, label, product: stored.product, key: stored.key, previous: stored.previous ? { product: stored.previous, when: stored.previous.fetched_at } : null });
  }
  if (kind === "receipt") {
    const receipt = sanitiseReceipt(parsed);
    if (!receipt || !receipt.items.length) return json({ error: "no receipt", reason: "I couldn't read that as a receipt. Flatten it, fill the frame, and try again." }, 422);
    const h = await householdOf(env, me.id);
    return json({ ok: true, receipt: await saveReceipt(env, { user: me, householdId: h?.id || null, receipt, thumb }), shared: Boolean(h) });
  }
  return json({ error: "unknown kind" }, 400);
}

// The page sends a ≤256 px JPEG it made itself. We keep it only if it really is
// small — dimensions read from the header, bytes capped — else no thumbnail (fail open).
async function cleanThumb(t) {
  if (!t || typeof t.arrayBuffer !== "function" || t.size === 0 || t.size > THUMB_MAX_BYTES) return null;
  const bytes = await t.arrayBuffer();
  const size = imageSize(bytes);
  if (!size || size.w > THUMB_MAX_PX || size.h > THUMB_MAX_PX) return null;
  return `data:image/${size.type};base64,${toBase64(bytes)}`;
}

// --- TEXT: "2 eggs and toast" → the same JSON, no photo. --------------------------
async function textMeal(env, cfg, me, body) {
  const text = String(body.text || "").trim().slice(0, 300);
  if (!text) return json({ error: "empty", reason: "Type what you ate." }, 400);
  const correction = String(body.correction || "").trim().slice(0, 200);
  // Same as the photo route: a correction arrives with the items on screen, and only
  // the ones it names may change.
  const current = sanitiseItems(listFrom(body.current), { source: "text" });
  const revising = Boolean(correction) && current.length > 0;
  let out;
  try { out = await runVision(env, cfg, { prompt: revising ? PROMPTS.revise(slim(current), correction, false) : PROMPTS.text(text, correction), maxTokens: 900 }); }
  catch (err) { console.error("foodlog text model failed", err?.message || err); return json({ error: "model", reason: "The model isn't answering just now. Try again in a minute." }, 502); }
  const parsed = extractJson(out.text);
  const fresh = sanitiseItems(parsed?.items, { source: "text" });
  const items = revising ? mergeCorrection(current, fresh, correction) : fresh;
  if (revising && !fresh.length) return json({ error: "no food", reason: "I couldn't apply that correction. Try naming the food and the amount, like “8 strawberries”." }, 422);
  if (!items.length) return json({ error: "no food", reason: "I couldn't turn that into foods. Try naming them plainly: '2 eggs, 1 slice of toast'." }, 422);
  const mealId = String(body.mealId || "").trim();
  const meal = mealId ? await updateMealItems(env, me, mealId, items) : await insertMeal(env, me, { date: pickDate(body.date), items, source: "text", thumb: null });
  if (!meal) return json({ error: "no such meal" }, 404);
  const after = mealId ? await editedMeal(env, me, meal, { tzOffsetMin: body.tz }) : await afterMeal(env, me, meal, { tzOffsetMin: body.tz });
  return json({ ok: true, meal, notes: String(parsed?.notes || "").slice(0, 200), honesty: HONESTY, totals: after.totals });
}

// --- THE MIC: the clip goes to Whisper on Workers AI (the same model the chat page uses,
//     YourBots/config.js → voice.sttModel), never to the browser's own speech service. ------
const STT_DEFAULT = "@cf/openai/whisper-large-v3-turbo";
async function transcribe(request, env) {
  if (!env.AI) return json({ error: "no-model", reason: "Voice needs Workers AI (wrangler.jsonc → ai binding)." }, 503);
  let form;
  try { form = await request.formData(); } catch { return json({ error: "bad request", reason: "Send the clip as multipart/form-data in an 'audio' field." }, 400); }
  const clip = form.get("audio");
  if (!clip || typeof clip.arrayBuffer !== "function") return json({ error: "bad request", reason: "No audio in the request." }, 400);
  if (clip.size > 4 * 1024 * 1024) return json({ error: "too-long", reason: "That clip is too big. Keep it under 30 seconds." }, 413);
  if (clip.size < 100) return json({ error: "empty", reason: "I didn't get any audio. Try again." }, 400);
  const model = String(CONFIG.voice?.sttModel || "").trim() || STT_DEFAULT;
  const t0 = Date.now();
  let out;
  try { out = await env.AI.run(model, { audio: toBase64(await clip.arrayBuffer()) }); }
  catch (err) { console.error("foodlog transcribe failed", err?.message || err); return json({ error: "model-error", reason: "I couldn't make out that clip. Try again, or type it." }, 502); }
  const text = String(out?.text || "").trim();
  console.log(JSON.stringify({ event: "foodlog-transcribe", bytes: clip.size, chars: text.length, ms: Date.now() - t0 }));
  if (!text) return json({ error: "empty", reason: "I couldn't hear any words in that. Try again a little closer to the mic." }, 422);
  return json({ text });
}

// --- SAY: one box for everything. A question goes to the coach; "chicken rice again" matches a
//     favourite before any model runs; anything else that reads like food is estimated. ---------
async function say(env, cfg, me, body) {
  const text = String(body.text || "").trim().slice(0, 600);
  const date = pickDate(body.date);
  if (!text) return json({ error: "empty", reason: "Say what you ate, or ask something." }, 400);
  const kind = classifySay(text);
  if (kind === "log") {
    const m = await matchFavourite(env, me, text);
    if (m) {
      const f = m.favourite;
      const when = f.lastUsed ? new Date(f.lastUsed).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }) : "before";
      return json({ ok: true, kind: "repeat", favourite: f, question: `Logging your ${f.label} from ${when}, about ${Math.round(f.kcal)} kcal. Right?` });
    }
    if (looksLikeFood(text)) {
      const r = await textMeal(env, cfg, me, { text, date, tz: body.tz });
      const d = await r.json();
      if (r.ok) return json({ ok: true, kind: "meal", ...d });
      if (d.error !== "no food") return json(d, r.status);
      // Not food after all: let the coach answer it.
    }
  }
  const u = await addWords(env, me, date, "user", "question", text);
  let a;
  try { a = await askDay(env, me, { date, text, coachName: cfg.coachName }); }
  catch (err) { console.error("foodlog ask failed", err?.message || err); return json({ error: "model", reason: "The coach isn't answering just now. Try again in a minute." }, 502); }
  const w = await addWords(env, me, date, "assistant", "answer", a.reply);
  return json({ ok: true, kind: "answer", turns: [u, w] });
}

// --- A meal saved by hand (barcode / label / receipt items come through here). ----
async function saveMeal(env, me, body) {
  const items = sanitiseItems(body.items, { source: ["barcode", "label", "text", "photo", "receipt"].includes(body.source) ? body.source : "text" });
  if (!items.length) return json({ error: "no items", reason: "Nothing to save." }, 400);
  const meal = await insertMeal(env, me, { date: pickDate(body.date), items, source: items[0].source, thumb: null });
  const after = await afterMeal(env, me, meal, { tzOffsetMin: body.tz });
  return json({ ok: true, meal, totals: after.totals });
}

async function insertMeal(env, me, { date, items, source, thumb }) {
  const id = randomId(12), t = totalsOf(items), now = nowIso();
  await env.DB.prepare(`INSERT INTO track_meals (id, user_id, date, time, items_json, kcal, protein_g, carbs_g, fat_g, thumb, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, me.id, date, now.slice(11, 16), JSON.stringify(items), t.kcal, t.protein_g, t.carbs_g, t.fat_g, thumb, source, now).run();
  return readMeal(env, id);
}
async function updateMealItems(env, me, id, items) {
  const row = await env.DB.prepare(`SELECT user_id FROM track_meals WHERE id = ?`).bind(id).first();
  if (!row || row.user_id !== me.id) return null;
  const t = totalsOf(items);
  await env.DB.prepare(`UPDATE track_meals SET items_json = ?, kcal = ?, protein_g = ?, carbs_g = ?, fat_g = ? WHERE id = ?`).bind(JSON.stringify(items), t.kcal, t.protein_g, t.carbs_g, t.fat_g, id).run();
  return readMeal(env, id);
}
async function readMeal(env, id) {
  const r = await env.DB.prepare(`SELECT * FROM track_meals WHERE id = ?`).bind(id).first();
  return r ? mealOut(r) : null;
}
function mealOut(r) { let items = []; try { items = JSON.parse(r.items_json); } catch {} return { id: r.id, date: r.date, time: r.time, items, kcal: r.kcal, protein_g: r.protein_g, carbs_g: r.carbs_g, fat_g: r.fat_g, thumb: r.thumb, source: r.source, created_at: r.created_at }; }

// --- THE DAY and THE WEEK. -------------------------------------------------------------
async function dayView(env, who, date, { readOnly = false } = {}) {
  const rows = (await env.DB.prepare(`SELECT * FROM track_meals WHERE user_id = ? AND date = ? ORDER BY created_at`).bind(who.id, date).all()).results || [];
  const meals = rows.map(mealOut);
  const totals = totalsOf(meals);
  const weightRow = await env.DB.prepare(`SELECT kg FROM track_weights WHERE user_id = ? AND date = ?`).bind(who.id, date).first();
  return { date, targets: who.targets, totals, meals, weight: weightRow?.kg ?? null, weights: await listWeights(env, who.id, 30), readOnly, name: who.name || null, honesty: HONESTY };
}

async function weekView(env, who, end) {
  const start = addDays(end, -6);
  const rows = (await env.DB.prepare(`SELECT date, SUM(kcal) kcal, SUM(protein_g) protein_g, SUM(carbs_g) carbs_g, SUM(fat_g) fat_g, COUNT(*) meals FROM track_meals WHERE user_id = ? AND date BETWEEN ? AND ? GROUP BY date`).bind(who.id, start, end).all()).results || [];
  const byDate = Object.fromEntries(rows.map((r) => [r.date, r]));
  const days = [];
  for (let i = 0; i < 7; i++) { const d = addDays(start, i); const r = byDate[d]; days.push({ date: d, kcal: Math.round(r?.kcal || 0), protein_g: round1(r?.protein_g || 0), carbs_g: round1(r?.carbs_g || 0), fat_g: round1(r?.fat_g || 0), meals: r?.meals || 0 }); }
  return { start, end, days, targets: who.targets, streak: await streakOf(env, who.id, end), adherence: adherenceOf(days, who.targets) };
}

// Streak: consecutive days with at least one meal, ending today or yesterday (today isn't over).
async function streakOf(env, userId, today) {
  const rows = (await env.DB.prepare(`SELECT DISTINCT date FROM track_meals WHERE user_id = ? AND date <= ? ORDER BY date DESC LIMIT 400`).bind(userId, today).all()).results || [];
  const have = new Set(rows.map((r) => r.date));
  let d = have.has(today) ? today : addDays(today, -1), n = 0;
  while (have.has(d)) { n++; d = addDays(d, -1); }
  return n;
}
// Adherence: of the logged days in the window, how many landed within ±15% of the calorie target.
function adherenceOf(days, targets) {
  const goal = Number(targets?.kcal) || 0;
  const logged = days.filter((d) => d.meals > 0);
  if (!goal || !logged.length) return null;
  const hit = logged.filter((d) => Math.abs(d.kcal - goal) / goal <= 0.15).length;
  return Math.round(100 * hit / logged.length);
}

// --- PEOPLE. Identity rows come from Engine/identity/; the food profile (targets) is track_users. ----
async function withProfile(env, user) {
  if (!user) return null;
  let r = await env.DB.prepare(`SELECT targets_json, created_at, last_seen FROM track_users WHERE id = ?`).bind(user.id).first();
  if (!r) { await env.DB.prepare(`INSERT OR IGNORE INTO track_users (id, targets_json, created_at, last_seen) VALUES (?, NULL, ?, ?)`).bind(user.id, user.created_at || nowIso(), nowIso()).run(); r = {}; }
  let targets = null; try { targets = r.targets_json ? JSON.parse(r.targets_json) : null; } catch {}
  return { id: user.id, bot: user.bot, email: user.email, targets, name: targets?.name || null, created_at: user.created_at, last_seen: user.last_seen };
}
async function userById(env, bot, id) { return withProfile(env, await idUserById(env, bot, id)); }
function touch(env, me) { idTouch(env, me); env.DB.prepare(`UPDATE track_users SET last_seen = ? WHERE id = ?`).bind(nowIso(), me.id).run().catch(() => {}); }
async function profile(env, me) {
  return { userId: me.id, email: me.email, targets: me.targets, devices: (await deviceCount(env, me.id)) || 1, household: await householdView(env, me) };
}
async function householdView(env, me) {
  const h = await householdOf(env, me.id);
  if (!h) return null;
  const members = [];
  for (const m of h.members) members.push({ ...m, weights: await listWeights(env, m.id, 30) });
  return { ...h, members };
}

function cleanTargets(t) {
  t = t && typeof t === "object" ? t : {};
  return {
    kcal: Math.round(clamp(t.kcal, 800, 8000, 2000)), protein_g: Math.round(clamp(t.protein_g, 0, 500, 150)),
    carbs_g: Math.round(clamp(t.carbs_g, 0, 1000, 200)), fat_g: Math.round(clamp(t.fat_g, 0, 400, 65)),
    unit: t.unit === "lb" ? "lb" : "kg", name: String(t.name || "").trim().slice(0, 40), preset: String(t.preset || "").slice(0, 12), weight_kg: round1(clamp(t.weight_kg, 0, 400, 0)) || null,
    goal_kg: round1(clamp(t.goal_kg, 0, 400, 0)) || null,   // optional: the weight screen draws it and projects a date
  };
}

// --- THE COACH (admin token). One bot's clients only. ------------------------------------
async function handleCoach(request, env, url, cfg, sub) {
  if (sub === "clients") return json({ clients: await clientRows(env, cfg.id), coachName: cfg.coachName, name: cfg.name, id: cfg.id });
  if (sub.startsWith("client/") && sub.endsWith("/summary")) {
    const who = await userById(env, cfg.id, sub.slice(7, -8));
    if (!who) return json({ error: "no such client" }, 404);
    const kind = url.searchParams.get("kind") === "day" ? "day" : "week";
    return json(await summaryFor(env, who, { date: pickDate(url.searchParams.get("end") || url.searchParams.get("date")), kind, coachName: cfg.coachName, force: url.searchParams.get("refresh") === "1" }));
  }
  if (sub.startsWith("client/")) {
    const who = await userById(env, cfg.id, sub.slice(7));
    if (!who) return json({ error: "no such client" }, 404);
    const end = todayUtc();
    const days = [];
    for (let i = 6; i >= 0; i--) days.push(await dayView(env, who, addDays(end, -i)));
    const week = await weekView(env, who, end);
    return json({ client: { ...who, household: await householdOf(env, who.id) }, days, week, pending: await pendingByEmail(env, cfg.id, who.email), devices: await listDevices(env, who.id) });
  }
  if (sub === "export.csv") return csv(await clientRows(env, cfg.id));
  if (sub === "link") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const b = await readJson(request);
    const out = await linkByCode(env, cfg.id, { email: cleanEmail(b.email), code: b.deviceCode || b.code });
    return json(out, out.ok ? 200 : out.status || 400);
  }
  return json({ error: "not found" }, 404);
}
async function clientRows(env, bot) {
  const rows = (await env.DB.prepare(`SELECT u.id, u.email, u.created_at, u.last_seen, t.targets_json, (SELECT MAX(created_at) FROM track_meals m WHERE m.user_id = u.id) last_log, (SELECT COUNT(*) FROM id_devices d WHERE d.user_id = u.id) devices, (SELECT COUNT(*) FROM id_pending p WHERE p.bot = u.bot AND p.email = u.email) pending, (SELECT h.name FROM track_members mb JOIN track_households h ON h.id = mb.household_id WHERE mb.user_id = u.id) household FROM id_users u LEFT JOIN track_users t ON t.id = u.id WHERE u.bot = ? ORDER BY last_log DESC`).bind(bot).all()).results || [];
  const out = [];
  for (const r of rows) {
    let targets = null; try { targets = r.targets_json ? JSON.parse(r.targets_json) : null; } catch {}
    const who = { id: r.id, email: r.email, targets, name: targets?.name || null, created_at: r.created_at, last_seen: r.last_seen };
    const week = await weekView(env, who, todayUtc());
    const w = await listWeights(env, who.id, 30);
    out.push({ id: who.id, email: who.email, name: who.name, targets: who.targets, created_at: who.created_at, last_seen: who.last_seen, last_log: r.last_log, devices: r.devices, pending: r.pending, household: r.household, streak: week.streak, adherence: week.adherence, daysLogged: week.days.filter((d) => d.meals).length, avgKcal: Math.round(week.days.filter((d) => d.meals).reduce((a, d) => a + d.kcal, 0) / (week.days.filter((d) => d.meals).length || 1)), weight: w.latest, weightChange30: w.change });
  }
  return out;
}

function csv(rows) {
  const cols = ["email", "name", "kcal_target", "protein_target", "carbs_target", "fat_target", "streak", "adherence_pct", "days_logged_7d", "avg_kcal_7d", "weight_kg", "weight_change_30d", "household", "last_log", "created_at"];
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [cols.join(",")].concat(rows.map((r) => [r.email, r.name, r.targets?.kcal, r.targets?.protein_g, r.targets?.carbs_g, r.targets?.fat_g, r.streak, r.adherence, r.daysLogged, r.avgKcal, r.weight, r.weightChange30, r.household, r.last_log, r.created_at].map(q).join(",")));
  return new Response(lines.join("\n") + "\n", { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="clients-${todayUtc()}.csv"` } });
}
