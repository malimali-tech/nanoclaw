import { describe, it, expect, vi } from 'vitest';

import { FeishuStreamHandle } from './handle.js';

interface Mocks {
  cardCreate: ReturnType<typeof vi.fn>;
  messageCreate: ReturnType<typeof vi.fn>;
  cardElementContent: ReturnType<typeof vi.fn>;
  cardUpdate: ReturnType<typeof vi.fn>;
  cardSettings: ReturnType<typeof vi.fn>;
}

function buildClient(overrides: Partial<Mocks> = {}): {
  client: ConstructorParameters<typeof FeishuStreamHandle>[0]['client'];
  mocks: Mocks;
} {
  const cardCreate =
    overrides.cardCreate ??
    vi.fn(async () => ({ code: 0, data: { card_id: 'card_1' } }));
  const messageCreate =
    overrides.messageCreate ??
    vi.fn(async () => ({
      code: 0,
      data: { message_id: 'om_1', chat_id: 'oc_1' },
    }));
  const cardElementContent =
    overrides.cardElementContent ?? vi.fn(async () => ({ code: 0 }));
  const cardUpdate = overrides.cardUpdate ?? vi.fn(async () => ({ code: 0 }));
  const cardSettings =
    overrides.cardSettings ?? vi.fn(async () => ({ code: 0 }));

  const client = {
    im: { message: { create: messageCreate } },
    cardkit: {
      v1: {
        card: {
          create: cardCreate,
          update: cardUpdate,
          settings: cardSettings,
        },
        cardElement: { content: cardElementContent },
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return {
    client,
    mocks: {
      cardCreate,
      messageCreate,
      cardElementContent,
      cardUpdate,
      cardSettings,
    },
  };
}

describe('FeishuStreamHandle', () => {
  it('lazily creates a CardKit card on first appendText', async () => {
    const { client, mocks } = buildClient();
    const handle = new FeishuStreamHandle({ client, chatId: 'oc_1' });

    expect(mocks.cardCreate).not.toHaveBeenCalled();
    await handle.appendText('Hello');
    await handle.finalize();

    expect(mocks.cardCreate).toHaveBeenCalledTimes(1);
    expect(mocks.messageCreate).toHaveBeenCalledTimes(1);
    const sentMessage = mocks.messageCreate.mock.calls[0][0];
    expect(sentMessage.data.msg_type).toBe('interactive');
    expect(sentMessage.data.content).toContain('"card_id":"card_1"');
  });

  it('streams cumulative text and finalizes with streaming_mode off', async () => {
    const { client, mocks } = buildClient();
    const handle = new FeishuStreamHandle({ client, chatId: 'oc_1' });

    await handle.appendText('Hello');
    await handle.appendText(' world');
    await handle.finalize();

    // At least one cardElement.content call with the cumulative text. The
    // exact count varies with throttle timing — we only assert the content
    // contract here.
    const contentCalls = mocks.cardElementContent.mock.calls;
    expect(contentCalls.length).toBeGreaterThanOrEqual(1);
    const lastContent = contentCalls[contentCalls.length - 1][0];
    expect(lastContent.data.content).toBe('Hello world');

    // finalize sends one card.update flipping streaming_mode false.
    expect(mocks.cardUpdate).toHaveBeenCalledTimes(1);
    const finalCard = JSON.parse(
      mocks.cardUpdate.mock.calls[0][0].data.card.data,
    );
    expect(finalCard.config.streaming_mode).toBe(false);
    expect(finalCard.body.elements[0].content).toBe('Hello world');
  });

  it('falls back to plain sendMessage when card creation fails', async () => {
    const cardCreate = vi.fn(async () => ({ code: 99, msg: 'boom' }));
    const { client, mocks } = buildClient({ cardCreate });
    const fallback = vi.fn(async () => {});
    const handle = new FeishuStreamHandle({
      client,
      chatId: 'oc_1',
      fallbackSend: fallback,
    });

    await handle.appendText('Hello');
    await handle.appendText(' world');
    await handle.finalize();

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith('Hello');
    // No CardKit content / update calls happened because creation failed.
    expect(mocks.cardElementContent).not.toHaveBeenCalled();
    expect(mocks.cardUpdate).not.toHaveBeenCalled();
  });

  it('drops reasoning / tool events without errors (deferred to next milestone)', async () => {
    const { client } = buildClient();
    const handle = new FeishuStreamHandle({ client, chatId: 'oc_1' });

    await expect(handle.appendReasoning('thinking…')).resolves.toBeUndefined();
    await expect(
      handle.appendToolUse('call_1', 'bash', { cmd: 'ls' }),
    ).resolves.toBeUndefined();
    await expect(
      handle.appendToolResult('call_1', 'bash', 'output', false),
    ).resolves.toBeUndefined();
    await handle.finalize();
  });

  it('finalize is idempotent', async () => {
    const { client, mocks } = buildClient();
    const handle = new FeishuStreamHandle({ client, chatId: 'oc_1' });
    await handle.appendText('hi');
    await handle.finalize();
    await handle.finalize();
    expect(mocks.cardUpdate).toHaveBeenCalledTimes(1);
  });

  it('finalize without any text appended makes no API calls', async () => {
    const { client, mocks } = buildClient();
    const handle = new FeishuStreamHandle({ client, chatId: 'oc_1' });
    await handle.finalize();
    expect(mocks.cardCreate).not.toHaveBeenCalled();
    expect(mocks.messageCreate).not.toHaveBeenCalled();
    expect(mocks.cardElementContent).not.toHaveBeenCalled();
    expect(mocks.cardUpdate).not.toHaveBeenCalled();
  });
});
