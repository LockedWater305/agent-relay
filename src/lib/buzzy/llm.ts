/**
 * Buzzy LLM harness — lightweight OpenAI-compatible chat completions.
 *
 * Reads BZ_CHAT_BASE_URL / BZ_CHAT_KEY / BZ_CHAT_MODEL from env.
 * Defaults to the Nous Inference API. Endpoint locality is a deployment fact,
 * not catalog metadata: `local` is bounded by BZ_CHAT_BASE_URL (see
 * CATALOG_IS_LOCAL). A loopback endpoint must itself be configured not to
 * proxy prompts to the cloud; this harness is not an application-wide firewall.
 *
 * BZ_CHAT_MODELS is a JSON array of { label, model } objects.
 * If unset, defaults to a single "Marvin" entry.
 */

const env = (key: string): string => {
  const v = process.env[key]?.trim();
  return v ?? "";
};

const BASE_URL = env("BZ_CHAT_BASE_URL") || "https://inference-api.nousresearch.com/v1";
const API_KEY = env("BZ_CHAT_KEY");
const DEFAULT_MODEL = env("BZ_CHAT_MODEL") || "z-ai/glm-5.3-flash";

/**
 * A catalog entry. Only `label` and `model` are required; the rest are optional
 * because they are curation metadata the deployment may or may not supply:
 *
 *  - `provider` — who serves the model. Absent means "not declared", NOT "any".
 *    An entry with no provider cannot satisfy a provider preference; the policy
 *    refuses rather than assuming.
 *  - `local` — true only when BASE_URL is a loopback endpoint. An entry may
 *    explicitly opt out with false, but cannot label a remote endpoint local.
 *  - `priceInPerMTok` / `priceOutPerMTok` — USD per million tokens. Absent means
 *    "no price map", and the `cheapest` control refuses rather than guessing.
 */
export interface CatalogModel {
  label: string;
  model: string;
  provider?: string;
  local?: boolean;
  priceInPerMTok?: number;
  priceOutPerMTok?: number;
}

/**
 * Compare the parsed HTTP(S) hostname, never a URL prefix. In particular,
 * localhost.evil.example and localhost@evil.example are remote endpoints.
 * Wildcard bind addresses, private LAN hosts and container aliases are not
 * loopback destinations and cannot satisfy a local-only inference request.
 */
export function isLoopbackModelEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    const host = url.hostname;
    // The URL parser canonicalises IPv4/IPv6 literals and validates octets.
    return host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/** True only when the configured inference endpoint is loopback. */
export const CATALOG_IS_LOCAL = isLoopbackModelEndpoint(BASE_URL);

/** Provider inferred from BASE_URL when an entry does not declare one. */
export const CATALOG_DEFAULT_PROVIDER = CATALOG_IS_LOCAL
  ? "local"
  : /nousresearch/i.test(BASE_URL)
    ? "nous"
    : "custom";

/** Parsed model catalog from BZ_CHAT_MODELS. */
let _models: CatalogModel[] | null = null;

function getModels(): CatalogModel[] {
  if (_models !== null) return _models;
  const raw = env("BZ_CHAT_MODELS");
  if (!raw) {
    _models = [{ label: "Marvin", model: DEFAULT_MODEL }];
  } else {
    try {
      _models = JSON.parse(raw);
    } catch {
      console.warn("[buzzy/llm] BZ_CHAT_MODELS is not valid JSON — using default");
      _models = [{ label: "Marvin", model: DEFAULT_MODEL }];
    }
  }
  // Every catalog model currently uses the same BASE_URL. Metadata can opt
  // out of locality, but cannot promote a remote endpoint into localOnly.
  _models = _models!.map((e) => ({
    ...e,
    provider: e.provider ?? CATALOG_DEFAULT_PROVIDER,
    local: CATALOG_IS_LOCAL && (e.local === undefined || e.local === true),
  }));
  return _models!;
}

if (!API_KEY) {
  console.warn("[buzzy/llm] BZ_CHAT_KEY is not set — chat will fail at runtime");
}

/**
 * Full chat-completion result: content + tool calls + usage + latency.
 * Phase 0 of the Tools & Agent Loop plan (plan doc 23): one change, three
 * unlocks — tools, the bounded model loop, and observability.
 */
export interface ToolCall {
  id: string;
  type: string;
  name: string;
  arguments: string;
}

export interface CompletionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface FullCompletion {
  content: string;
  toolCalls: ToolCall[];
  usage: CompletionUsage | null;
  latencyMs: number;
  model: string;
  finishReason: string | null;
}

function assertLocalInference(localOnly?: boolean): void {
  if (localOnly && !CATALOG_IS_LOCAL) {
    throw new Error("Local-only inference requires a loopback BZ_CHAT_BASE_URL; nothing was sent");
  }
}

/**
 * Call the chat completions endpoint, returning everything the wire offers:
 * assistant text, tool calls, token usage, and latency.
 * @param messages — chat messages.
 * @param opts — optional model override, temperature, max tokens, tool schemas.
 */
export async function chatCompletionFull(
  messages: Array<{ role: string; content: string }>,
  opts?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    tools?: unknown[];
    toolChoice?: string | object;
    /** Enforce the endpoint boundary even when a caller bypasses model policy. */
    localOnly?: boolean;
  },
): Promise<FullCompletion> {
  assertLocalInference(opts?.localOnly);
  const model = opts?.model || DEFAULT_MODEL;
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts?.temperature ?? 0.7,
    // Reasoning/thinking models (glm, qwen-thinking, kimi) burn output budget
    // on chain-of-thought before emitting the answer. 512 tokens often left
    // content null (answer never reached), which made the old reasoning-tail
    // fallback surface raw thinking. Give the answer room to appear.
    max_tokens: opts?.maxTokens ?? 2048,
    stream: false,
  };
  if (opts?.tools?.length) {
    body.tools = opts.tools;
    if (opts.toolChoice !== undefined) body.tool_choice = opts.toolChoice;
  }

  // One retry on an empty/failed completion — glm occasionally returns an
  // empty first choice; a single immediate retry usually recovers (dogfood #10004).
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      body.temperature = Math.min((opts?.temperature ?? 0.7) + 0.2, 1);
    }
    try {
      return await postCompletionFull(body);
    } catch (err) {
      lastError = err;
      if (err instanceof Error && /LLM request failed \((4\d\d)\)/.test(err.message)) {
        throw err; // auth/permission errors won't fix themselves — fail fast
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("LLM call failed");
}

/**
 * Streaming text lane. The buffered call is why a typed turn showed nothing for
 * 9-13s: the client waited for the WHOLE reply before painting a word. This
 * streams deltas so the first words land at TTFT (~1s) instead of at the end.
 *
 * Tool turns stay on the buffered path — a tool call needs the complete
 * assistant message before anything can be executed.
 */
export async function chatCompletionStream(
  messages: Array<{ role: string; content: string }>,
  opts: { model?: string; temperature?: number; maxTokens?: number; localOnly?: boolean } | undefined,
  onText: (delta: string) => void,
): Promise<FullCompletion> {
  assertLocalInference(opts?.localOnly);
  const model = opts?.model || DEFAULT_MODEL;
  const url = BASE_URL.replace(/\/+$/, "") + "/chat/completions";
  const started = Date.now();
  const res = await fetch(url, {
    method: "POST",
    // A local endpoint must not redirect prompts (including 307/308 bodies)
    // to a remote service. Remote/Advocate endpoints retain normal redirects.
    redirect: CATALOG_IS_LOCAL ? "error" : "follow",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts?.temperature ?? 0.7,
      max_tokens: opts?.maxTokens ?? 2048,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    const text = res.ok ? "no body" : await res.text();
    throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 500)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason: string | null = null;
  let servedModel = model;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let parsed: any;
      try { parsed = JSON.parse(payload); } catch { continue; }
      if (parsed.model) servedModel = String(parsed.model);
      const choice = parsed.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta?.content;
      if (typeof delta === "string" && delta) {
        content += delta;
        onText(delta);
      }
      if (choice.finish_reason) finishReason = String(choice.finish_reason);
    }
  }
  return {
    content: content.trim(),
    toolCalls: [],
    usage: null,
    latencyMs: Date.now() - started,
    model: servedModel,
    finishReason,
  };
}

async function postCompletionFull(body: Record<string, unknown>): Promise<FullCompletion> {
  // Join rather than resolve an absolute path, which would drop a base /v1.
  const url = new URL(
    BASE_URL.replace(/\/+$/, "") + "/chat/completions",
  );
  const started = Date.now();

  const res = await fetch(url.toString(), {
    method: "POST",
    redirect: CATALOG_IS_LOCAL ? "error" : "follow",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 500)}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
        reasoning?: string;
        tool_calls?: Array<{
          id?: string;
          type?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
      finish_reason?: string | null;
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    } | null;
    model?: string;
  };

  const msg = json.choices?.[0]?.message;
  const content = msg?.content?.trim() ?? "";

  // Tool calls: a tool-call turn legitimately has empty content, so the
  // guards below only fire when there are ALSO no tool calls.
  const toolCalls: ToolCall[] = (msg?.tool_calls ?? [])
    .map((tc) => ({
      id: tc.id ?? "",
      type: tc.type ?? "function",
      name: tc.function?.name ?? "",
      arguments: tc.function?.arguments ?? "{}",
    }))
    .filter((tc) => tc.name !== "");

  const usage = json.usage
    ? {
        promptTokens: json.usage.prompt_tokens ?? 0,
        completionTokens: json.usage.completion_tokens ?? 0,
        totalTokens: json.usage.total_tokens ?? 0,
      }
    : null;

  // Thinking models may also return the answer in a `reasoning`-adjacent field
  // ONLY when the provider folds it into content. We never surface chain-of-
  // thought: if content is present, use it as-is; `reasoning` is disregarded
  // entirely (the old fallback leaked raw reasoning — dogfood B1).
  if (!content && toolCalls.length === 0) {
    if (msg?.reasoning?.trim()) {
      // No answer text this turn — the model spent the budget on thinking.
      // Throw so the retry loop recovers rather than ever returning
      // chain-of-thought as the reply.
      throw new Error("LLM returned reasoning only (no content)");
    }
    throw new Error("LLM returned no content in first choice");
  }

  return {
    content,
    toolCalls,
    usage,
    latencyMs: Date.now() - started,
    model: json.model ?? String(body.model ?? ""),
    finishReason: json.choices?.[0]?.finish_reason ?? null,
  };
}

/**
 * Call the chat completions endpoint.
 * @param messages — chat messages.
 * @param opts — optional model override, temperature, max tokens.
 * @returns the assistant text from the first choice.
 */
export async function chatCompletion(
  messages: Array<{ role: string; content: string }>,
  opts?: { model?: string; temperature?: number; maxTokens?: number; localOnly?: boolean },
): Promise<string> {
  const full = await chatCompletionFull(messages, opts);
  return full.content;
}

export { getModels };

/**
 * Test seam: install a synthetic catalog (or clear the memoised one) so the
 * policy can be exercised against catalogs the deployment does not have — no
 * local models, no price map, several providers. Never called from runtime code.
 */
export function __resetModelCatalogForTests(next?: CatalogModel[]): void {
  _models = next ?? null;
}

/**
 * Resolve a client-supplied model reference to a real catalog model id.
 * Accepts a friendly label ("Marvin") or a legacy raw id. Undefined when the
 * reference isn't in the catalog. The client only ever sees labels — raw ids
 * never cross the wire (dogfood B3).
 */
export function resolveModel(labelOrModel?: string): string | undefined {
  if (!labelOrModel) return undefined;
  const models = getModels();
  const byLabel = models.find((m) => m.label === labelOrModel);
  if (byLabel) return byLabel.model;
  const byModel = models.find((m) => m.model === labelOrModel);
  return byModel?.model;
}

/**
 * A reasoning-capable model id from the catalog, if one is present — used for
 * high-stakes job types (legal, technical) where a thinking model helps.
 * Undefined when the catalog has no obvious reasoning entry, so callers fall
 * back to the default.
 */
export function resolveReasoningModel(): string | undefined {
  const m = getModels().find((x) => /think|reason|kimi|qwen/i.test((x.label || "") + " " + (x.model || "")));
  return m?.model;
}
