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
    // Final card uses buildCompleteCard's structure (tool-use panel +
    // reasoning + main markdown + footer). We just assert that the
    // accumulated text appears somewhere in the body.
    const dump = JSON.stringify(finalCard.body.elements);
    expect(dump).toContain('Hello world');
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

  it('CardKit writes share a single monotonic sequence — no overtake under concurrent slow flushes', async () => {
    // Simulate a slow network on cardElement.content so a second appendText
    // and a tool_use-triggered card.update get a chance to enqueue before
    // the first cardElement.content's promise settles. Without the write
    // chain, runCardUpdate's seq could race ahead of the in-flight content
    // call and CardKit (which trusts arrival order for the same element)
    // would overwrite the longer text with the older short one — the
    // observable "reply rewinds" bug.
    const sequences: { kind: string; seq: number; len?: number }[] = [];
    let releaseFirstContent: (() => void) | null = null;
    const firstContentLatch = new Promise<void>((resolve) => {
      releaseFirstContent = resolve;
    });
    let contentCalls = 0;

    const cardElementContent = vi.fn(async (req: any) => {
      contentCalls++;
      sequences.push({
        kind: 'content',
        seq: req.data.sequence,
        len: req.data.content.length,
      });
      if (contentCalls === 1) await firstContentLatch;
      return { code: 0 };
    });
    const cardUpdate = vi.fn(async (req: any) => {
      sequences.push({ kind: 'update', seq: req.data.sequence });
      return { code: 0 };
    });

    const { client } = buildClient({ cardElementContent, cardUpdate });
    const handle = new FeishuStreamHandle({ client, chatId: 'oc_1' });

    // Trigger a slow first content flush, then queue more work behind it.
    await handle.appendText('A');
    const more = Promise.all([
      handle.appendText('B'),
      handle.appendToolUse('call_1', 'lark-cli', { cmd: 'foo' }),
      handle.appendToolResult('call_1', 'lark-cli', 'ok', false),
    ]);

    // Let the slow first cardElement.content finally settle.
    releaseFirstContent!();
    await more;
    await handle.finalize();

    // Every observed seq is strictly greater than the previous one — no
    // out-of-order arrivals at CardKit, regardless of how the throttle and
    // tool-update timers interleave.
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i].seq).toBeGreaterThan(sequences[i - 1].seq);
    }
  });

  it('retries cardElement.content on transient 5xx and recovers without losing the flush', async () => {
    let attempts = 0;
    const cardElementContent = vi.fn(async (req: any) => {
      attempts++;
      // First attempt: simulate the SDK rejecting with a 500-class body
      // code (CardKitApiError isRetryable path). Second attempt: succeed.
      if (attempts === 1) return { code: 503, msg: 'service unavailable' };
      return { code: 0, ...req };
    });
    const { client, mocks } = buildClient({ cardElementContent });
    const handle = new FeishuStreamHandle({ client, chatId: 'oc_1' });

    await handle.appendText('A');
    await handle.appendText('B');
    await handle.finalize();

    // 2 attempts on the first flush, then the second flush sees seq=2 and
    // either finds the buffer unchanged from lastFlushedText (no-op) or
    // sends seq=2 cleanly. Either way we got >=1 successful content call
    // and the final card carries 'AB'.
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(mocks.cardUpdate).toHaveBeenCalledTimes(1);
    const finalCard = JSON.parse(
      mocks.cardUpdate.mock.calls[0][0].data.card.data,
    );
    expect(JSON.stringify(finalCard.body.elements)).toContain('AB');
  });

  it('does not retry deterministic business errors (e.g. invalid sequence)', async () => {
    let attempts = 0;
    const cardElementContent = vi.fn(async () => {
      attempts++;
      // 230002 is a hypothetical sequence-out-of-order; not in the
      // retryable set, should fail-fast.
      return { code: 230002, msg: 'sequence is invalid' };
    });
    const { client } = buildClient({ cardElementContent });
    const handle = new FeishuStreamHandle({ client, chatId: 'oc_1' });

    await handle.appendText('A');
    await handle.finalize();
    expect(attempts).toBe(1);
  });

  it('preserves the streaming element content across tool-call card.updates (no wipe-and-retype)', async () => {
    // Reproduces the user-reported bug: when reasoning is mid-stream and a
    // tool call fires, runCardUpdate replaced the card with an empty
    // STREAMING_ELEMENT_ID, then a separate cardElement.content re-pushed
    // the buffer. CardKit rendered the empty intermediate state as a
    // clear-then-retype, so users saw the "thinking" block wipe and
    // re-stream. Fix: bake the current streamingContent into the
    // card.update payload itself.
    const { client, mocks } = buildClient();
    const handle = new FeishuStreamHandle({ client, chatId: 'oc_1' });

    // Simulate a thinking phase + tool call mid-stream.
    await handle.appendReasoning('let me check the calendar');
    await handle.appendToolUse('call_1', 'lark-cli', { cmd: 'agenda' });
    // Allow runCardUpdate's 200ms timer to fire.
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await handle.appendToolResult('call_1', 'lark-cli', 'ok', false);
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await handle.finalize();

    // Every card.update during the streaming phase (i.e. NOT the final
    // complete card) must carry the current reasoning text in its
    // streaming markdown element. If any of them have an empty content
    // there, that's the visual "wipe" the user complained about.
    const updateCalls = mocks.cardUpdate.mock.calls;
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    // The last call is the terminal complete card; check the others.
    for (const call of updateCalls.slice(0, -1)) {
      const card = JSON.parse(call[0].data.card.data);
      const streamingEl = card.body.elements.find(
        (e: { element_id?: string }) => e.element_id === 'streaming_content',
      );
      expect(streamingEl).toBeDefined();
      // Must carry the reasoning text. Empty string would mean the
      // wipe-and-retype animation is back.
      expect(streamingEl.content).toContain('let me check');
    }
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
