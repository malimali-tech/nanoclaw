/**
 * Thin wrappers over Lark CardKit + IM SDK calls used by the streaming
 * pipeline. Each function takes the SDK client explicitly so the caller owns
 * credential plumbing — no global state.
 *
 * Adapted from openclaw-lark/src/card/cardkit.ts (MIT, ByteDance).
 */

import * as Lark from '@larksuiteoapi/node-sdk';

interface CardKitResponse {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export class CardKitApiError extends Error {
  constructor(
    public api: string,
    public code: number,
    msg: string,
    public context: string,
  ) {
    super(`cardkit ${api} failed code=${code} msg=${msg} (${context})`);
    this.name = 'CardKitApiError';
  }
}

function checkResponse(
  api: string,
  context: string,
  resp: CardKitResponse,
): void {
  const { code, msg } = resp;
  if (code && code !== 0) {
    throw new CardKitApiError(api, code, msg ?? '', context);
  }
}

/**
 * Codes / classes worth retrying. CardKit's body-level codes for
 * server-side flakes (5xx-equivalent + ratelimit), plus thrown errors
 * the SDK couldn't classify (network resets, timeouts).
 *
 * NOT retried: business errors (sequence out-of-order, invalid payload),
 * auth failures, missing card_id — those are deterministic given the same
 * inputs and would just burn another second of wall-clock.
 */
const RETRY_BODY_CODES = new Set<number>([
  // 230020 — message-level rate limit (legacy IM patch path)
  230020,
  // 99991663 — token expired/invalid; not actually retryable but the
  // SDK sometimes returns it transiently mid-token-refresh, so one retry
  // catches the brief window.
  99991663,
]);

function isRetryable(err: unknown): boolean {
  if (err instanceof CardKitApiError) {
    return RETRY_BODY_CODES.has(err.code) || (err.code >= 500 && err.code < 600);
  }
  // SDK threw before we got a response body — usually network. Worth one
  // shot. node-sdk wraps Axios errors; check the canonical shape.
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; response?: { status?: unknown } };
    const httpStatus =
      typeof e.response?.status === 'number' ? e.response.status : undefined;
    if (httpStatus != null && httpStatus >= 500 && httpStatus < 600) return true;
    if (typeof e.code === 'string') {
      // Common Node net errors that are worth a retry.
      return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(
        e.code,
      );
    }
  }
  return false;
}

/**
 * Run `fn` with up to 2 retries on transient failures. Backoff is short
 * (100ms then 400ms) because every retry stalls the streaming card —
 * users tolerate a 500ms hiccup, not a 5s pause. Non-retryable errors
 * surface immediately without backoff.
 */
async function withRetry<T>(api: string, fn: () => Promise<T>): Promise<T> {
  const delaysMs = [100, 400];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === delaysMs.length || !isRetryable(err)) throw err;
      // eslint-disable-next-line no-console -- low-volume, only logs on actual transient
      console.warn(
        `[cardkit:${api}] transient failure (${err instanceof Error ? err.message : String(err)}), retry ${attempt + 1}/${delaysMs.length} in ${delaysMs[attempt]}ms`,
      );
      await new Promise<void>((resolve) =>
        setTimeout(resolve, delaysMs[attempt]),
      );
    }
  }
  throw lastErr;
}

/**
 * Create a CardKit card entity. Returns the `card_id`, which can then be
 * referenced by `sendCardByCardId` to wire it to a chat message and updated
 * via `streamCardContent` / `updateCardKitCard`.
 */
export async function createCardEntity(
  client: Pick<Lark.Client, 'im' | 'cardkit'>,
  card: Record<string, unknown>,
): Promise<string> {
  return withRetry('card.create', async () => {
    const response = (await client.cardkit.v1.card.create({
      data: {
        type: 'card_json',
        data: JSON.stringify(card),
      },
    })) as CardKitResponse;
    checkResponse('card.create', '', response);
    const cardId =
      (response.data?.card_id as string | undefined) ??
      ((response as Record<string, unknown>).card_id as string | undefined);
    if (!cardId) {
      throw new CardKitApiError(
        'card.create',
        response.code ?? -1,
        response.msg ?? 'no card_id in response',
        JSON.stringify(response),
      );
    }
    return cardId;
  });
}

/**
 * Send an `interactive` message that references a CardKit `card_id`. The
 * returned `message_id` lets us recover the chat-side message later if we
 * need to fall back to IM-patch updates (e.g. CardKit ratelimit).
 */
export async function sendCardByCardId(
  client: Pick<Lark.Client, 'im' | 'cardkit'>,
  chatId: string,
  cardId: string,
): Promise<{ messageId: string; chatId: string }> {
  const content = JSON.stringify({ type: 'card', data: { card_id: cardId } });
  const response = await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'interactive',
      content,
    },
  });
  return {
    messageId: response?.data?.message_id ?? '',
    chatId: response?.data?.chat_id ?? '',
  };
}

/**
 * Stream a new value into a single card element. CardKit diffs the new
 * `content` against the previous and renders the typewriter animation. The
 * `content` is the *cumulative* text, not a delta — callers maintain their
 * own buffer.
 */
export async function streamCardContent(
  client: Pick<Lark.Client, 'im' | 'cardkit'>,
  args: {
    cardId: string;
    elementId: string;
    content: string;
    sequence: number;
  },
): Promise<void> {
  return withRetry('cardElement.content', async () => {
    const resp = (await client.cardkit.v1.cardElement.content({
      data: { content: args.content, sequence: args.sequence },
      path: { card_id: args.cardId, element_id: args.elementId },
    })) as CardKitResponse;
    checkResponse(
      'cardElement.content',
      `seq=${args.sequence} len=${args.content.length}`,
      resp,
    );
  });
}

/**
 * Replace the entire card JSON. Used for the final settled state (e.g. when
 * `streaming_mode` flips off and we want to swap in any decoration that the
 * incremental element-level API can't express).
 */
export async function updateCardKitCard(
  client: Pick<Lark.Client, 'im' | 'cardkit'>,
  args: {
    cardId: string;
    card: Record<string, unknown>;
    sequence: number;
  },
): Promise<void> {
  return withRetry('card.update', async () => {
    const resp = (await client.cardkit.v1.card.update({
      data: {
        card: { type: 'card_json', data: JSON.stringify(args.card) },
        sequence: args.sequence,
      },
      path: { card_id: args.cardId },
    })) as CardKitResponse;
    checkResponse('card.update', `seq=${args.sequence}`, resp);
  });
}

/**
 * Toggle the card's `streaming_mode`. Should be flipped to `false` once the
 * stream finishes so the card returns to normal interaction behaviour
 * (forwarding, action callbacks, etc.).
 */
export async function setCardStreamingMode(
  client: Pick<Lark.Client, 'im' | 'cardkit'>,
  args: { cardId: string; streamingMode: boolean; sequence: number },
): Promise<void> {
  return withRetry('card.settings', async () => {
    const resp = (await client.cardkit.v1.card.settings({
      data: {
        settings: JSON.stringify({ streaming_mode: args.streamingMode }),
        sequence: args.sequence,
      },
      path: { card_id: args.cardId },
    })) as CardKitResponse;
    checkResponse(
      'card.settings',
      `seq=${args.sequence} mode=${args.streamingMode}`,
      resp,
    );
  });
}
