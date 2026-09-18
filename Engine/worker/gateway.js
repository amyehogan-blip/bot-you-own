// ============================================================================
//  LAYER 3b — THE GATEWAY
//
//  One function: complete({ env, config, system, messages, stream, model, maxTokens, meta }).
//  It talks to whichever model YourBots/config.js names (or the `model` you
//  pass — the router uses this for cheap turns), through Cloudflare AI Gateway
//  when a gateway id is set, and hands back either the full text or an async
//  iterator of text chunks. `meta` is an empty object you pass in; on the way
//  out it says how the call went (meta.gateway, meta.usage).
//
//  Why a gateway at all: it's the dollar ceiling. AI Gateway gives you logs,
//  caching, a per-minute rate limit, a SPEND LIMIT in dollars, and Guardrails
//  (Llama Guard at the edge) — all from the dashboard, none of it in code.
//  See docs/DEPLOY.md. Fails open: if the gateway call errors, we retry without it.
//
//  The gateway is ON by default (id "bot-you-own") but it has to EXIST on your
//  account before it does anything. Until it does, every call falls back to
//  the model directly, one warning goes in the log, and nobody's chat breaks.
//
//  Providers:
//    workers-ai  — no key. env.AI.run(). Default.
//    openai      — secret OPENAI_API_KEY. Chat Completions.
//    anthropic   — secret ANTHROPIC_API_KEY. Messages API.
// ============================================================================

// ---- what the last call did, for Under the hood → Gateway & model -----------
//  "via gateway"               — the call went through AI Gateway
//  "direct (gateway missing)"  — a gateway id is set but no such gateway exists yet
//  "direct (gateway error)"    — the gateway answered with some other error; we retried without it
//  "direct (not configured)"   — gateway.id is empty
let lastGatewayStatus = "direct (not configured)";
let warnedMissing = false;          // the "create it" warning goes in the log once per isolate
let gatewayMissingUntil = 0;        // after a "not found", skip the gateway for a while instead of failing every call twice
const MISSING_RECHECK_MS = 5 * 60 * 1000;

export function gatewayStatus(config) {
  const id = config?.gateway?.id || "";
  return {
    id,
    lastCall: lastGatewayStatus,
    cacheTtl: Number(config?.gateway?.cacheTtl || 0),
    note: !id ? "gateway.id is empty — calls go straight to the model"
      : lastGatewayStatus === "direct (gateway missing)" ? `no gateway named "${id}" on this account yet — create it (docs/OWNER-CHECKLIST.md §1, or DEPLOY.md §D for the API route); calls go direct until then`
      : lastGatewayStatus === "via gateway" ? "logs, rate limit and spend limit live in the dashboard: AI → AI Gateway → " + id
      : "no call has gone through the gateway yet in this isolate",
  };
}

// Does this error mean "there is no gateway with that name"? Today Workers AI
// says exactly: `2001: Please configure AI Gateway in the Cloudflare dashboard`.
// The check is a little broader in case the wording moves — and it only ever
// decides which fallback message we log, never whether the visitor gets an answer.
function isGatewayMissing(err) {
  const m = String(err?.message || err || "");
  return /please configure ai gateway|^\s*2001\b|\b2001:|gateway[^.]{0,40}(not found|does not exist|doesn't exist|no such)|(not found|does not exist|no such)[^.]{0,40}gateway/i.test(m);
}

export async function complete({ env, config, system, messages, stream = false, model = "", maxTokens = 0, meta = {} }) {
  const provider = config.provider || "workers-ai";
  const opts = { env, config, system, messages, stream, model: model || config.model, maxTokens: maxTokens || config.maxTokens || 900, meta };
  if (provider === "openai") return openai(opts);
  if (provider === "anthropic") return anthropic(opts);
  return workersAI(opts);
}

// ---------------------------------------------------------------- Workers AI
async function workersAI({ env, config, system, messages, stream, model, maxTokens, meta }) {
  if (!env.AI) throw new Error("Workers AI binding missing (wrangler.jsonc → \"ai\")");
  const input = {
    messages: [{ role: "system", content: system }, ...messages],
    max_tokens: maxTokens,
    stream,
  };
  const id = config.gateway?.id || "";
  const useGateway = id && Date.now() >= gatewayMissingUntil;
  const gw = useGateway
    ? { gateway: { id, skipCache: !(config.gateway.cacheTtl > 0), cacheTtl: config.gateway.cacheTtl || undefined } }
    : undefined;

  let result;
  try {
    result = gw ? await env.AI.run(model, input, gw) : await env.AI.run(model, input);
    meta.gateway = gw ? "via gateway" : id ? "direct (gateway missing)" : "direct (not configured)";
  } catch (err) {
    // Gateway Guardrails block: surface as a refusal, not a crash (codes 2016 / 2017).
    if (/2016|2017|blocked due to security/i.test(String(err?.message))) {
      const e = new Error("blocked-by-gateway"); e.code = "gateway-blocked"; throw e;
    }
    if (!gw) throw err;
    if (isGatewayMissing(err)) {
      gatewayMissingUntil = Date.now() + MISSING_RECHECK_MS;
      meta.gateway = "direct (gateway missing)";
      if (!warnedMissing) {
        warnedMissing = true;
        console.warn(`AI Gateway "${id}" doesn't exist on this account yet — calls are going direct (no logs, no spend limit). Create it: dashboard → AI → AI Gateway → Create Gateway, name it "${id}" (or the curl in docs/DEPLOY.md §D). Checked again in ${MISSING_RECHECK_MS / 60000} min. Error was: ${String(err?.message || err).slice(0, 160)}`);
      }
    } else {
      meta.gateway = "direct (gateway error)";
      console.error("gateway call failed, retrying direct", err?.message || err);
    }
    result = await env.AI.run(model, input);
  }
  lastGatewayStatus = meta.gateway;

  if (!stream) {
    if (result?.usage) meta.usage = result.usage;
    return String(result?.response ?? result?.choices?.[0]?.message?.content ?? "");
  }
  // Streaming: Workers AI returns a ReadableStream of SSE lines.
  return sseTextChunks(result, (obj) => obj?.response ?? obj?.choices?.[0]?.delta?.content ?? "", meta);
}

// ------------------------------------------------------------------- OpenAI
async function openai({ env, config, system, messages, stream, model, maxTokens, meta }) {
  const key = env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY secret not set");
  const base = gatewayBase(config, "openai") || "https://api.openai.com/v1";
  lastGatewayStatus = meta.gateway = gatewayBase(config, "openai") ? "via gateway" : "direct (not configured)";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, ...messages],
      max_tokens: maxTokens,
      stream,
    }),
  });
  if (!res.ok) throw await httpError(res);
  if (!stream) {
    const data = await res.json();
    if (data?.usage) meta.usage = data.usage;
    return String(data?.choices?.[0]?.message?.content ?? "");
  }
  return sseTextChunks(res.body, (obj) => obj?.choices?.[0]?.delta?.content ?? "", meta);
}

// ---------------------------------------------------------------- Anthropic
// Raw Messages API over fetch (no SDK) so the Worker stays dependency-free and
// the request can be routed through AI Gateway's /anthropic path.
async function anthropic({ env, config, system, messages, stream, model, maxTokens, meta }) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY secret not set");
  const base = gatewayBase(config, "anthropic") || "https://api.anthropic.com";
  lastGatewayStatus = meta.gateway = gatewayBase(config, "anthropic") ? "via gateway" : "direct (not configured)";
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      system,
      messages,
      max_tokens: maxTokens,
      stream,
    }),
  });
  if (!res.ok) throw await httpError(res);
  if (!stream) {
    const data = await res.json();
    if (data?.usage) meta.usage = data.usage;
    if (data?.stop_reason === "refusal") {
      const e = new Error("refusal"); e.code = "model-refusal"; throw e;
    }
    return (data?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  return sseTextChunks(res.body, (obj) =>
    obj?.type === "content_block_delta" && obj?.delta?.type === "text_delta" ? obj.delta.text : "",
    meta
  );
}

// ------------------------------------------------------------------ helpers
function gatewayBase(config, provider) {
  const { id, accountId } = config.gateway || {};
  if (!id || !accountId) return null;
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${id}/${provider}`;
}

async function httpError(res) {
  let detail = "";
  try { detail = (await res.text()).slice(0, 300); } catch {}
  const e = new Error(`${res.status} from provider: ${detail}`);
  if (res.status === 429) e.code = "rate-limited";
  return e;
}

// Turn an SSE body into an async iterator of text chunks. If a chunk carries
// token counts (Workers AI and OpenAI put them on the last one), keep them on meta.
async function* sseTextChunks(body, pick, meta = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const obj = JSON.parse(payload);
        if (obj?.usage) meta.usage = obj.usage;
        const text = pick(obj);
        if (text) yield text;
      } catch { /* partial line; ignore */ }
    }
  }
}
