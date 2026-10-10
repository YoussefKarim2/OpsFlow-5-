/**
 * The two AI providers Ask OpsFlow can talk to, behind one small interface.
 *
 * Plain `fetch`, no SDK — the same choice the Graph mailer made (ARCHITECTURE.md
 * §13.7): one request shape each, injectable for tests, nothing new in the
 * dependency tree. The assistant loop (assistant.ts) speaks only the neutral
 * `Turn` / `ProviderReply` shapes below; each adapter translates them to its
 * provider's wire format and back.
 *
 * Two provider rules shape this file:
 *   - Both providers may "think" before calling a tool, and both require that
 *     thinking (Claude's thinking blocks, Gemini's thought signatures) to be
 *     sent back unchanged with the tool results. So each reply keeps the
 *     provider's own content in `raw`, and the next request echoes it as is
 *     rather than rebuilding it from the text and tool calls.
 *   - The tools stay the same on every round of one question; to make the
 *     model answer instead of looking something else up, the request says
 *     "no tool calls" (`toolChoice: 'none'`) rather than removing the tools.
 *
 * Neither adapter ever logs or returns the key. An error carries the HTTP
 * status and the provider's own one-line message, nothing else.
 */

import { config } from '../../config.js';

export type Fetcher = typeof fetch;

/** A tool the model may call, described in JSON Schema (the subset both providers accept). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: 'string' | 'integer' | 'boolean'; description: string; enum?: string[] }>;
    required?: string[];
  };
}

export interface ToolCall {
  /** The provider's id for the call (Claude has one; Gemini does not, so one is made up). */
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** The conversation, provider-neutral. */
export type Turn =
  | { role: 'user'; text: string }
  | {
      role: 'assistant';
      text: string;
      toolCalls?: ToolCall[];
      /** The provider's own content for this turn, echoed back unchanged (see above). */
      raw?: { provider: 'anthropic' | 'gemini'; content: unknown };
    }
  | { role: 'tool'; results: Array<{ id: string; name: string; content: string }> };

export interface ProviderReply {
  text: string;
  toolCalls: ToolCall[];
  raw?: { provider: 'anthropic' | 'gemini'; content: unknown };
}

export interface ChatRequest {
  system: string;
  turns: Turn[];
  tools: ToolSpec[];
  /** `none` asks for an answer with no further tool calls. */
  toolChoice?: 'auto' | 'none';
  /** Cancels the request (the person left, or the overall deadline passed). */
  signal?: AbortSignal;
}

export interface AssistantProvider {
  readonly name: 'anthropic' | 'gemini';
  readonly model: string;
  chat(req: ChatRequest): Promise<ProviderReply>;
}

/** The provider could not answer. `status` is the HTTP status, 0 for a network failure or timeout. */
export class ProviderError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

// Low-cost, fast models with reliable tool use. Overridable with ASSISTANT_MODEL.
// `gemini-flash-latest` is Google's alias for its current Flash model, so a
// new key is never pointed at a model Google has closed to new projects.
export const DEFAULT_MODELS = { anthropic: 'claude-haiku-5-5', gemini: 'gemini-flash-latest' } as const;

/** One provider call. The whole question has its own, shorter deadline (routes/assistant.ts). */
const CALL_TIMEOUT_MS = 45_000;
/** Includes the model's thinking, which counts against the same budget. */
const MAX_OUTPUT_TOKENS = 4_000;

async function post(fetcher: Fetcher, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
  try {
    res = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (e) {
    const name = (e as Error).name;
    throw new ProviderError(`AI provider unreachable: ${name === 'TimeoutError' || name === 'AbortError' ? 'timed out or cancelled' : 'network error'}`, 0);
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* reported below */ }
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } } | null)?.error?.message;
    throw new ProviderError(`AI provider refused the request (${res.status})${msg ? `: ${String(msg).slice(0, 200)}` : ''}`, res.status);
  }
  if (json === null) throw new ProviderError('AI provider sent an unreadable answer', res.status);
  return json;
}

// ── Claude (Anthropic Messages API) ─────────────────────────────────────────

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'thinking' | 'redacted_thinking'; [k: string]: unknown };

export function anthropicProvider(apiKey: string, model: string, fetcher: Fetcher = fetch): AssistantProvider {
  return {
    name: 'anthropic',
    model,
    async chat({ system, turns, tools, toolChoice = 'auto', signal }) {
      const messages: Array<{ role: 'user' | 'assistant'; content: string | AnthropicBlock[] }> = turns.map((t) => {
        if (t.role === 'user') return { role: 'user', content: t.text };
        if (t.role === 'tool') {
          return { role: 'user', content: t.results.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.id, content: r.content })) };
        }
        if (t.raw?.provider === 'anthropic' && Array.isArray(t.raw.content)) {
          return { role: 'assistant', content: t.raw.content as AnthropicBlock[] };
        }
        const blocks: AnthropicBlock[] = [];
        if (t.text) blocks.push({ type: 'text', text: t.text });
        for (const c of t.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
        return { role: 'assistant', content: blocks.length ? blocks : t.text };
      });
      // No `temperature`: the current models refuse any non-default sampling
      // setting, and answers here are grounded in tool results anyway.
      const json = await post(fetcher, 'https://api.anthropic.com/v1/messages', {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      }, {
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        tool_choice: { type: toolChoice },
        messages,
      }, signal) as { content?: AnthropicBlock[]; stop_reason?: string };
      const content = Array.isArray(json.content) ? json.content : [];
      const text = content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join('\n').trim();
      const toolCalls = content
        .filter((b): b is Extract<AnthropicBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, args: b.input && typeof b.input === 'object' ? b.input : {} }));
      if (!text && !toolCalls.length && json.stop_reason === 'max_tokens') {
        throw new ProviderError('AI provider ran out of room before answering', 200);
      }
      return { text, toolCalls, raw: { provider: 'anthropic', content } };
    },
  };
}

// ── Gemini (Google generateContent) ─────────────────────────────────────────

/** Gemini's schema dialect is OpenAPI's: upper-case type names. */
function geminiSchema(p: ToolSpec['parameters']) {
  return {
    type: 'OBJECT',
    properties: Object.fromEntries(Object.entries(p.properties).map(([k, v]) => [k, {
      type: v.type.toUpperCase(), description: v.description, ...(v.enum ? { enum: v.enum } : {}),
    }])),
    ...(p.required?.length ? { required: p.required } : {}),
  };
}

type GeminiPart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: { result: string } };
};

export function geminiProvider(apiKey: string, model: string, fetcher: Fetcher = fetch): AssistantProvider {
  return {
    name: 'gemini',
    model,
    async chat({ system, turns, tools, toolChoice = 'auto', signal }) {
      const contents = turns.map((t) => {
        if (t.role === 'user') return { role: 'user', parts: [{ text: t.text }] as GeminiPart[] };
        if (t.role === 'tool') {
          return { role: 'user', parts: t.results.map((r) => ({ functionResponse: { name: r.name, response: { result: r.content } } })) as GeminiPart[] };
        }
        if (t.raw?.provider === 'gemini' && Array.isArray(t.raw.content)) {
          return { role: 'model', parts: t.raw.content as GeminiPart[] };
        }
        const parts: GeminiPart[] = [];
        if (t.text) parts.push({ text: t.text });
        for (const c of t.toolCalls ?? []) parts.push({ functionCall: { name: c.name, args: c.args } });
        return { role: 'model', parts };
      });
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const json = await post(fetcher, url, { 'x-goog-api-key': apiKey }, {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) }],
        toolConfig: { functionCallingConfig: { mode: toolChoice === 'none' ? 'NONE' : 'AUTO' } },
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      }, signal) as { candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }> };
      const candidate = json.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      let n = 0;
      const text = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text!).join('\n').trim();
      const toolCalls = parts
        .filter((p) => p.functionCall)
        .map((p) => ({ id: `call_${++n}`, name: p.functionCall!.name, args: p.functionCall!.args ?? {} }));
      if (!text && !toolCalls.length && candidate?.finishReason === 'MAX_TOKENS') {
        throw new ProviderError('AI provider ran out of room before answering', 200);
      }
      return { text, toolCalls, raw: { provider: 'gemini', content: parts } };
    },
  };
}

// ── Choosing one from the configuration ─────────────────────────────────────

/** The provider the configuration asks for, or null when the assistant is off. */
export function configuredProvider(fetcher: Fetcher = fetch): AssistantProvider | null {
  if (!config.ASSISTANT_ENABLED) return null;
  const anthropicKey = config.ANTHROPIC_API_KEY?.trim();
  const geminiKey = config.GEMINI_API_KEY?.trim();
  const choice = config.ASSISTANT_PROVIDER ?? (anthropicKey ? 'anthropic' : geminiKey ? 'gemini' : null);
  const model = config.ASSISTANT_MODEL.trim();
  if (choice === 'anthropic' && anthropicKey) return anthropicProvider(anthropicKey, model || DEFAULT_MODELS.anthropic, fetcher);
  if (choice === 'gemini' && geminiKey) return geminiProvider(geminiKey, model || DEFAULT_MODELS.gemini, fetcher);
  return null;
}
