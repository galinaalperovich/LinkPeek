// Talks to the model. Two adapters (Claude Messages API, OpenAI Chat
// Completions) behind one streaming interface.
//
// Callers pass provider-neutral messages:
//   { role: 'user' | 'assistant', parts: [
//       { type: 'text', text, cache?: boolean },
//       { type: 'pdf', data: <base64>, name },
//   ] }
// and receive a stream of
//   { type: 'text', text }      a piece of the answer
//   { type: 'reset' }           discard what was streamed so far (model fallback)
//   { type: 'done', stopReason: 'end' | 'length' | 'refusal', detail, model }

import { sseEvents } from './sse.js';
import { PROVIDERS } from './settings.js';

export class ProviderError extends Error {
  constructor(message, { status = 0, code = 'provider', detail = '' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

const ANTHROPIC_VERSION = '2026-10-21';
const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
// These models run safety classifiers that can decline a request (a security
// write-up is enough to trip one). Server-side fallback re-runs a declined
// request on another model inside the same call.
const ANTHROPIC_FALLBACK_MODELS =
  /^claude-(?:opus-5(?:-5)?|sonnet-5-5|fable-5-[12])$/;
// Room for the model's own reasoning plus a long "detailed" summary.
const MAX_OUTPUT_TOKENS = 16000;

function anthropicHeaders(apiKey) {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    // Needed for any request that carries a browser Origin header. The key is
    // only ever used from the extension's service worker, never from a page.
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

function toAnthropicPart(part) {
  const cache = part.cache ? { cache_control: { type: 'ephemeral' } } : {};
  if (part.type === 'pdf') {
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: part.data },
      ...cache,
    };
  }
  return { type: 'text', text: part.text, ...cache };
}

function toOpenAIContent(parts) {
  if (parts.every((part) => part.type === 'text')) {
    return parts.map((part) => part.text).join('\n\n');
  }
  return parts.map((part) =>
    part.type === 'pdf'
      ? {
          type: 'file',
          file: {
            filename: part.name || 'document.pdf',
            file_data: `data:application/pdf;base64,${part.data}`,
          },
        }
      : { type: 'text', text: part.text },
  );
}

function stopReason(raw) {
  if (raw === 'max_tokens' || raw === 'length') return 'length';
  if (raw === 'refusal' || raw === 'content_filter') return 'refusal';
  return 'end';
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const ADAPTERS = {
  anthropic: {
    label: PROVIDERS.anthropic.label,

    // `tuned` adds the optional knobs. If the endpoint rejects them, the
    // request is retried without (see open()).
    build({ apiKey, baseUrl, model, system, messages }, tuned) {
      const fallback = tuned && ANTHROPIC_FALLBACK_MODELS.test(model);
      const headers = anthropicHeaders(apiKey);
      const body = {
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        stream: true,
        system,
        messages: messages.map((message) => ({
          role: message.role,
          content: message.parts.map(toAnthropicPart),
        })),
      };
      if (tuned) body.output_config = { effort: 'low' }; // a peek should be quick
      if (fallback) {
        headers['anthropic-beta'] = ANTHROPIC_FALLBACK_BETA;
        body.fallbacks = 'default';
      }
      return { url: `${baseUrl}/v1/messages`, headers, body };
    },

    async *read(res) {
      if (!isEventStream(res)) {
        const json = await res.json();
        const text = (json.content || [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');
        if (text) yield { type: 'text', text };
        yield {
          type: 'done',
          stopReason: stopReason(json.stop_reason),
          detail: json.stop_details?.category || '',
          model: json.model || '',
        };
        return;
      }

      let stop = null;
      let detail = '';
      let model = '';
      for await (const { data } of sseEvents(res.body)) {
        const event = parseJson(data);
        if (!event) continue;
        switch (event.type) {
          case 'message_start':
            model = event.message?.model || model;
            break;
          case 'content_block_start':
            if (event.content_block?.type === 'fallback') {
              // A model declined mid-answer and another one is starting over.
              model = event.content_block.to?.model || model;
              yield { type: 'reset' };
            } else if (event.content_block?.type === 'text' && event.content_block.text) {
              yield { type: 'text', text: event.content_block.text };
            }
            break;
          case 'content_block_delta':
            // Thinking and signature deltas are deliberately ignored.
            if (event.delta?.type === 'text_delta' && event.delta.text) {
              yield { type: 'text', text: event.delta.text };
            }
            break;
          case 'message_delta':
            stop = event.delta?.stop_reason ?? stop;
            detail = event.delta?.stop_details?.category || event.stop_details?.category || detail;
            break;
          case 'error':
            throw streamError(event.error, this.label);
          default:
            break;
        }
      }
      yield { type: 'done', stopReason: stopReason(stop), detail, model };
    },
  },

  openai: {
    label: PROVIDERS.openai.label,

    build({ apiKey, baseUrl, model, system, messages }, tuned) {
      const body = {
        model,
        stream: true,
        messages: [
          { role: 'system', content: system },
          ...messages.map((message) => ({
            role: message.role,
            content: toOpenAIContent(message.parts),
          })),
        ],
      };
      if (tuned) body.reasoning_effort = 'low';
      return {
        url: `${baseUrl}/chat/completions`,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body,
      };
    },

    async *read(res) {
      if (!isEventStream(res)) {
        const json = await res.json();
        const choice = json.choices?.[0];
        const text = choice?.message?.content || choice?.message?.refusal || '';
        if (typeof text === 'string' && text) yield { type: 'text', text };
        yield {
          type: 'done',
          stopReason: stopReason(choice?.finish_reason),
          detail: '',
          model: json.model || '',
        };
        return;
      }

      let stop = null;
      let model = '';
      for await (const { data } of sseEvents(res.body)) {
        if (data === '[DONE]') break;
        const event = parseJson(data);
        if (!event) continue;
        if (event.error) throw streamError(event.error, this.label);
        model = event.model || model;
        const choice = event.choices?.[0];
        if (!choice) continue;
        const piece = choice.delta?.content ?? choice.delta?.refusal;
        if (typeof piece === 'string' && piece) yield { type: 'text', text: piece };
        if (choice.finish_reason) stop = choice.finish_reason;
      }
      yield { type: 'done', stopReason: stopReason(stop), detail: '', model };
    },
  },
};

function isEventStream(res) {
  return (res.headers.get('content-type') || '').includes('text/event-stream');
}

function streamError(error, label) {
  const type = error?.type || error?.code || '';
  const detail = error?.message || '';
  const message = /overloaded/i.test(type)
    ? `${label} is overloaded right now. Try again in a moment.`
    : `${label} stopped with an error.`;
  return new ProviderError(message, { code: String(type || 'provider'), detail });
}

async function errorFromResponse(res, label, model) {
  let detail = '';
  let type = '';
  try {
    const json = await res.json();
    const error = json?.error ?? json;
    detail = typeof error === 'string' ? error : error?.message || '';
    type = String(error?.type || error?.code || '');
  } catch {
    // Not JSON: the status code is all there is to go on.
  }
  const status = res.status;
  let message;
  let code = 'provider';
  if (status === 401) {
    message = `${label} rejected the API key. Check it in LinkPeek settings.`;
    code = 'auth';
  } else if (status === 403) {
    message = `This API key is not allowed to do that on ${label}.`;
    code = 'auth';
  } else if (status === 404) {
    const aboutModel = /model/i.test(`${type} ${detail}`) || type === 'not_found_error';
    message =
      aboutModel && model
        ? `${label} does not know the model "${model}". Pick another one in LinkPeek settings.`
        : `${label} endpoint not found. Check the API base URL in LinkPeek settings.`;
    code = 'model';
  } else if (status === 413) {
    message = 'That page is too large for the model.';
    code = 'too-large';
  } else if (status === 429) {
    message = `${label} rate limit or quota reached. Wait a moment, or check your plan and billing.`;
    code = 'rate-limit';
  } else if (status >= 500) {
    message = `${label} is having trouble right now (HTTP ${status}). Try again in a moment.`;
    code = 'unavailable';
  } else {
    message = `${label} could not process the request (HTTP ${status}).`;
  }
  return new ProviderError(message, { status, code, detail });
}

async function send(adapter, request, tuned) {
  const { url, headers, body } = adapter.build(request, tuned);
  try {
    return await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ProviderError(`Could not reach ${adapter.label}. Check your connection.`, {
      code: 'network',
      detail: String(err?.message || err),
    });
  }
}

async function open(adapter, request) {
  let res = await send(adapter, request, true);
  if (res.status === 400) {
    // Older models and OpenAI-compatible servers do not accept every tuning
    // field. Fall back to the plainest request before giving up.
    const plain = await send(adapter, request, false);
    res.body?.cancel().catch(() => {});
    res = plain;
  }
  if (!res.ok) throw await errorFromResponse(res, adapter.label, request.model);
  return res;
}

/**
 * Streams a model reply.
 * @param {{ provider: 'anthropic' | 'openai', apiKey: string, baseUrl: string,
 *           model: string, system: string, messages: object[], signal?: AbortSignal }} request
 */
export async function* streamChat(request) {
  const adapter = ADAPTERS[request.provider];
  if (!adapter) throw new ProviderError(`Unknown provider "${request.provider}".`);
  const res = await open(adapter, request);
  yield* adapter.read(res);
}

/** Lists the models the key can use. Doubles as a free key check. */
export async function listModels({ provider, apiKey, baseUrl, signal }) {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new ProviderError(`Unknown provider "${provider}".`);
  const url = provider === 'anthropic' ? `${baseUrl}/v1/models?limit=100` : `${baseUrl}/models`;
  const headers =
    provider === 'anthropic' ? anthropicHeaders(apiKey) : { authorization: `Bearer ${apiKey}` };
  let res;
  try {
    res = await fetch(url, { headers, signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ProviderError(`Could not reach ${adapter.label}. Check your connection.`, {
      code: 'network',
      detail: String(err?.message || err),
    });
  }
  if (!res.ok) throw await errorFromResponse(res, adapter.label, '');
  const json = await res.json().catch(() => null);
  const items = Array.isArray(json?.data) ? json.data : [];
  return items
    .filter((item) => typeof item?.id === 'string')
    .map((item) => ({ id: item.id, label: item.display_name || item.id }));
}
