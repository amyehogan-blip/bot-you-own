// ============================================================================
//  THE SANDBOX — a keyed visitor's own bot, on this deployment, for two weeks.
//
//  "Make your own, here": paste the Instructions from a custom GPT, or start from
//  a licensed prompt in the library below, add a few knowledge files, and chat
//  with it from the sidebar. Only that person (this browser's identity) and the
//  admin can see or use it. It expires after SANDBOX_DAYS and can be deleted any
//  time. "Take it with you" hands back the three files a real bot folder needs.
//
//  Who may: the same key as deploy — on the allowlist, or a redeemed deploy code.
//
//    GET    /api/sandbox?bot=<guide>              { allowed, bots, library, limits }
//    POST   /api/sandbox   {bot, name, greeting, instructions | library, starters}   → { bot }
//    GET    /api/sandbox/<id>                     the full bot (owner) — for "take it with you"
//    POST   /api/sandbox/<id>/file   multipart    add one knowledge file (converted to text)
//    DELETE /api/sandbox/<id>
// ============================================================================

import { tourState } from "./tour.js";
import { savedProjects, saveProject, deleteSavedProject, pickPublic, hrefFor } from "./projects.js";
import { deviceHash, userForDeviceAnyBot } from "../identity/devices.js";
import { extractText, gate as fileGate, scanText } from "./library.js";
import { json } from "./track-common.js";
import { PROJECTS } from "../../YourBots/index.js";

// What may not go into a bot's instructions or files: a card number, an ID number, a key, a password.
const BLOCKS = ["card", "ssn", "iban", "secret", "password", "privkey"];
const blocked = (text) => { const f = scanText(text).filter((x) => BLOCKS.includes(x.id)); return f.length ? `That contains what looks like ${f.map((x) => x.label.toLowerCase()).join(", ")} — take it out first.` : ""; };

export const SANDBOX_DAYS = 14, MAX_PER_PERSON = 3, MAX_FILES = 8, MAX_FILE_CHARS = 50000, MAX_INSTRUCTIONS = 20000;

// Licensed, original, verified to exist. The server fetches the text at import time;
// nothing is copied into this repo. Keep the credit line: MIT asks for it.
export const LIBRARY = [
  { id: "fabric-extract-wisdom", name: "Extract wisdom", blurb: "Pulls ideas, quotes, habits and references out of anything you paste — a transcript, an article.", source: "danielmiessler/fabric", licence: "MIT", url: "https://raw.githubusercontent.com/danielmiessler/fabric/main/data/patterns/extract_wisdom/system.md", starters: ["Here's a transcript — pull the wisdom out of it:", "What are the top ideas in this article?"] },
  { id: "fabric-create-summary", name: "Summariser", blurb: "A 20-word overview, the main points, the takeaways. Paste anything long.", source: "danielmiessler/fabric", licence: "MIT", url: "https://raw.githubusercontent.com/danielmiessler/fabric/main/data/patterns/create_summary/system.md", starters: ["Summarise this for me:", "Give me the takeaways from this email thread:"] },
  { id: "fabric-improve-writing", name: "Writing improver", blurb: "Fixes grammar, clarity and flow without changing what you meant.", source: "danielmiessler/fabric", licence: "MIT", url: "https://raw.githubusercontent.com/danielmiessler/fabric/main/data/patterns/improve_writing/system.md", starters: ["Tighten this paragraph:", "Make this email sound confident but friendly:"] },
  { id: "fabric-explain-code", name: "Code explainer", blurb: "Explains what a piece of code does, in plain words.", source: "danielmiessler/fabric", licence: "MIT", url: "https://raw.githubusercontent.com/danielmiessler/fabric/main/data/patterns/explain_code/system.md", starters: ["What does this function do?", "Explain this error message:"] },
  { id: "fabric-write-essay", name: "Essay writer", blurb: "Writes a clear, personal essay on a topic you give it.", source: "danielmiessler/fabric", licence: "MIT", url: "https://raw.githubusercontent.com/danielmiessler/fabric/main/data/patterns/write_essay/system.md", starters: ["Write 500 words on why small businesses should own their tools", "An essay on saying no"] },
  { id: "hub-code-reviewer", name: "Senior code reviewer", blurb: "A staff-engineer persona that reviews code and ranks findings by severity.", source: "LichAmnesia/GPT-Prompt-Hub", licence: "MIT", url: "https://raw.githubusercontent.com/LichAmnesia/GPT-Prompt-Hub/main/prompts/engineering/senior-code-reviewer.md", starters: ["Review this function:", "What would you change in this SQL?"] },
  { id: "hub-prd-writer", name: "PRD writer", blurb: "A product-manager persona with an 11-section PRD template, driven by KPIs.", source: "LichAmnesia/GPT-Prompt-Hub", licence: "MIT", url: "https://raw.githubusercontent.com/LichAmnesia/GPT-Prompt-Hub/main/prompts/business/product-manager-prd-writer-kpi-driven.md", starters: ["Write a PRD for a booking page for a dentist", "Turn this idea into a one-page PRD:"] },
  { id: "hub-socratic-tutor", name: "Socratic tutor", blurb: "Teaches any topic by asking, seven moves at a time.", source: "LichAmnesia/GPT-Prompt-Hub", licence: "MIT", url: "https://raw.githubusercontent.com/LichAmnesia/GPT-Prompt-Hub/main/prompts/learning/socratic-polymath-tutor-any-topic.md", starters: ["Teach me how DNS works", "I want to understand compound interest"] },
];

const now = () => new Date().toISOString();
const newId = () => "sb-" + [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");

// Whose browser is this, on any bot? The email, or "".
export async function sandboxOwnerOf(env, request) {
  if (!env.DB) return "";
  try { const k = await deviceHash(request); const u = k ? await userForDeviceAnyBot(env, k) : null; return u ? u.email : ""; } catch { return ""; }
}
async function mine(env, email) {
  const saved = await savedProjects(env);
  return Object.values(saved).filter((p) => p.sandbox && p.sandbox.email === email && !(p.sandbox.expires_at && p.sandbox.expires_at < now()));
}
// Sidebar rows: the visitor's own; the admin sees every sandbox with a badge. Expired ones are swept here.
let SWEPT_AT = 0;
export async function visibleSandboxes(env, request, { isAdmin, all }) {
  if (!env.DB) return [];
  if (Date.now() - SWEPT_AT > 3600 * 1000) { SWEPT_AT = Date.now(); try { for (const p of Object.values(await savedProjects(env))) if (p.sandbox?.expires_at && p.sandbox.expires_at < now()) await deleteSavedProject(env, p.id); } catch {} }
  const row = (p) => ({ id: p.id, ...pickPublic(p), kind: "chat", href: hrefFor(p), access: "open", listed: true, source: "sandbox", sandbox: { expires_at: p.sandbox.expires_at, source: p.sandbox.source, ...(isAdmin ? { email: p.sandbox.email } : {}) } });
  if (isAdmin) return Object.values(await savedProjects(env)).filter((p) => p.sandbox).map(row);
  const email = await sandboxOwnerOf(env, request); if (!email) return [];
  return (await mine(env, email)).map(row);
}

function cleanStarters(a) { return (Array.isArray(a) ? a : []).map((x) => String(x || "").trim().slice(0, 120)).filter(Boolean).slice(0, 4); }
async function fetchLibrary(id) {
  const item = LIBRARY.find((l) => l.id === id); if (!item) return { error: "No such library prompt." };
  try {
    const r = await fetch(item.url, { signal: AbortSignal.timeout(10000), headers: { "user-agent": "bot-you-own sandbox importer" } });
    if (!r.ok) return { error: `The library answered ${r.status}. Try again in a minute.` };
    let text = (await r.text()).replace(/\r/g, "").trim().slice(0, MAX_INSTRUCTIONS);
    // fabric patterns end with an "# INPUT" section that expects the text appended; a chat bot gets it as a message instead
    text = text.replace(/\n#+\s*INPUT[\s\S]*$/i, "").trim();
    return { item, text: text + `\n\n(Prompt: "${item.name}" from ${item.source}, ${item.licence} licence.)` };
  } catch (err) { return { error: "Couldn't fetch that prompt right now: " + (err?.message || err) }; }
}

export async function handleSandbox(request, env, url, { isAdmin, allowed, settings, resolveProject, guard }) {
  if (!env.DB) return json({ error: "The sandbox needs the D1 database." }, 503);
  const m = url.pathname.match(/^\/api\/sandbox(?:\/(sb-[0-9a-f]{8}))?(?:\/(file))?$/);
  if (!m) return json({ error: "not found" }, 404);
  const [, id, sub] = m;
  const email = isAdmin ? "" : await sandboxOwnerOf(env, request);
  const guideId = String(url.searchParams.get("bot") || "").toLowerCase();

  // Building here is for anyone who signed up — the key gates the code and the deploy button, not this.
  const keyed = async () => {
    if (isAdmin) return true;
    if (email) return true;
    let guide = guideId ? await resolveProject(env, guideId) : null;
    if (!guide || !guide.tour) { const gid = Object.entries(PROJECTS).find(([, p]) => p.tour)?.[0]; guide = gid ? await resolveProject(env, gid) : null; }
    if (!guide || !guide.tour) return false;
    const t = await tourState(env, request, guide, { links: settings.links });
    return Boolean(t.deploy?.allowed);
  };

  if (!id) {
    if (request.method === "GET") {
      const ok = email || isAdmin ? await keyed() : false;
      const bots = isAdmin ? [] : email ? (await mine(env, email)).map((p) => ({ id: p.id, name: p.name, expires_at: p.sandbox.expires_at, files: Object.keys(p.files || {}).length, source: p.sandbox.source })) : [];
      // the page gets a readable source page per prompt (the raw URL stays server-side)
      return json({ allowed: ok, signedUp: Boolean(email) || isAdmin, bots, library: LIBRARY.map(({ url, ...l }) => ({ ...l, page: url.replace("https://raw.githubusercontent.com/", "https://github.com/").replace(/\/main\//, "/blob/main/") })), limits: { days: SANDBOX_DAYS, perPerson: MAX_PER_PERSON, files: MAX_FILES, fileChars: MAX_FILE_CHARS, instructions: MAX_INSTRUCTIONS } });
    }
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!(await allowed(env, request))) return json({ error: "rate-limited", reason: "Slow down a little." }, 429);
    if (!email && !isAdmin) return json({ error: "sign-up", reason: "Sign up first." }, 401);
    if (!(await keyed())) return json({ error: "sign-up", reason: "Sign up first, then build here." }, 403);
    const body = (await request.json().catch(() => ({}))) || {};
    const owner = email || "admin";
    if (!isAdmin && (await mine(env, email)).length >= MAX_PER_PERSON) return json({ error: "limit", reason: `You can have ${MAX_PER_PERSON} sandbox bots at a time. Delete one to make room.` }, 400);
    let instructions = String(body.instructions || "").trim().slice(0, MAX_INSTRUCTIONS), starters = cleanStarters(body.starters), source = "pasted";
    if (body.library) { const lib = await fetchLibrary(String(body.library)); if (lib.error) return json({ error: "library", reason: lib.error }, 502); instructions = lib.text; source = lib.item.source + " · " + lib.item.name; if (!starters.length) starters = lib.item.starters || []; }
    if (instructions.length < 20) return json({ error: "instructions", reason: "Paste the instructions (at least a sentence), or pick one from the library." }, 400);
    const bad = blocked(instructions); if (bad) return json({ error: "instructions", reason: bad }, 400);
    const bid = newId();
    const name = String(body.name || "").trim().slice(0, 60) || "My bot";
    const p = await saveProject(env, bid, {
      kind: "chat", order: -1, name, tagline: "Your sandbox bot · expires in " + SANDBOX_DAYS + " days",
      greeting: String(body.greeting || "").trim().slice(0, 400) || `Hi — I'm ${name}. What can I do for you?`,
      starters, mode: "imported", grounding: "open", instructions, files: {},
      handoffText: "", handoffContact: "", allowedLinks: [], access: "open", listed: false,
      sandbox: { email: owner, userId: "", expires_at: new Date(Date.now() + SANDBOX_DAYS * 86400 * 1000).toISOString(), source },
    });
    console.log(JSON.stringify({ event: "sandbox-create", bot: bid, source }));
    return json({ ok: true, bot: { id: p.id, name: p.name, expires_at: p.sandbox.expires_at, source } });
  }

  // One bot: owner or admin only.
  const project = await resolveProject(env, id);
  if (!project || !project.sandbox || project.id !== id) return json({ error: "not found" }, 404);
  if (!isAdmin && project.sandbox.email !== email) return json({ error: "not yours" }, 403);
  if (request.method === "DELETE") { await deleteSavedProject(env, id); console.log(JSON.stringify({ event: "sandbox-delete", bot: id })); return json({ ok: true }); }
  if (!sub && request.method === "GET") return json({ bot: { id: project.id, name: project.name, greeting: project.greeting, starters: project.starters, instructions: project.instructions, files: project.files || {}, expires_at: project.sandbox.expires_at, source: project.sandbox.source } });
  if (sub === "file" && request.method === "POST") {
    if (!(await allowed(env, request))) return json({ error: "rate-limited", reason: "Slow down a little." }, 429);
    let form; try { form = await request.formData(); } catch { return json({ error: "form", reason: "Send the file as multipart/form-data in a 'file' field." }, 400); }
    const f = form.get("file"); if (!f || typeof f === "string") return json({ error: "file", reason: "No file." }, 400);
    if (Object.keys(project.files || {}).length >= MAX_FILES) return json({ error: "limit", reason: `A sandbox bot holds ${MAX_FILES} files. Remove one first.` }, 400);
    const g = fileGate(f.name, f.size); if (!g.ok) return json({ error: "file", reason: g.reason }, 400);
    let text = ""; try { text = await extractText(env, g.name, g.ext, await f.arrayBuffer()); } catch (err) { console.error("sandbox: extract failed", err?.message || err); }
    text = String(text || "").trim(); if (!text) return json({ error: "file", reason: "Couldn't read any text out of that file." }, 400);
    const bad = blocked(text); if (bad) return json({ error: "file", reason: bad }, 400);
    const fname = g.name.replace(/\.[a-z0-9]+$/i, "") .slice(0, 60) + ".md";
    const files = { ...(project.files || {}), [fname]: text.slice(0, MAX_FILE_CHARS) };
    await saveProject(env, id, { ...project, files, grounding: "open" });
    return json({ ok: true, file: fname, chars: Math.min(text.length, MAX_FILE_CHARS), cut: text.length > MAX_FILE_CHARS, files: Object.keys(files) });
  }
  if (sub === "file" && request.method === "DELETE") {
    const name = String(url.searchParams.get("name") || ""); const files = { ...(project.files || {}) }; delete files[name];
    await saveProject(env, id, { ...project, files }); return json({ ok: true, files: Object.keys(files) });
  }
  return json({ error: "method" }, 405);
}
