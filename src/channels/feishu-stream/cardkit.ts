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

function checkResponse(api: string, context: string, resp: CardKitResponse): void {
  const { code, msg } = resp;
  if (code && code !== 0) {
    throw new CardKitApiError(api, code, msg ?? '', context);
  }
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
  const resp = (await client.cardkit.v1.cardElement.content({
    data: { content: args.content, sequence: args.sequence },
    path: { card_id: args.cardId, element_id: args.elementId },
  })) as CardKitResponse;
  checkResponse(
    'cardElement.content',
    `seq=${args.sequence} len=${args.content.length}`,
    resp,
  );
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
  const resp = (await client.cardkit.v1.card.update({
    data: {
      card: { type: 'card_json', data: JSON.stringify(args.card) },
      sequence: args.sequence,
    },
    path: { card_id: args.cardId },
  })) as CardKitResponse;
  checkResponse('card.update', `seq=${args.sequence}`, resp);
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
}
