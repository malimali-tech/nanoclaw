import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  getInFlightCards,
  recordInFlightCard,
} from '../../db.js';
import { reconcileInFlightCards } from './reconcile.js';

function buildClient(overrides: {
  cardElementContent?: ReturnType<typeof vi.fn>;
  cardSettings?: ReturnType<typeof vi.fn>;
} = {}) {
  const cardElementContent =
    overrides.cardElementContent ?? vi.fn(async () => ({ code: 0 }));
  const cardSettings =
    overrides.cardSettings ?? vi.fn(async () => ({ code: 0 }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    client: {
      im: { message: { create: vi.fn() } },
      cardkit: {
        v1: {
          card: {
            create: vi.fn(),
            update: vi.fn(),
            settings: cardSettings,
          },
          cardElement: { content: cardElementContent },
        },
      },
    } as any,
    mocks: { cardElementContent, cardSettings },
  };
}

describe('reconcileInFlightCards', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('drops the table content even when no cards are in flight', async () => {
    const { client } = buildClient();
    const result = await reconcileInFlightCards(client);
    expect(result).toEqual({ scanned: 0, recovered: 0, failed: 0 });
  });

  it('appends an interrupt notice and flips streaming_mode off for each row', async () => {
    recordInFlightCard({
      cardId: 'card_a',
      chatId: 'oc_1',
      messageId: 'om_1',
    });
    recordInFlightCard({
      cardId: 'card_b',
      chatId: 'oc_2',
      messageId: 'om_2',
    });

    const { client, mocks } = buildClient();
    const result = await reconcileInFlightCards(client);

    expect(result.scanned).toBe(2);
    expect(result.recovered).toBe(2);
    expect(result.failed).toBe(0);

    // 2 cards × 1 cardElement.content + 1 setCardStreamingMode each
    expect(mocks.cardElementContent).toHaveBeenCalledTimes(2);
    expect(mocks.cardSettings).toHaveBeenCalledTimes(2);

    // Interrupt notice landed in STREAMING_ELEMENT_ID
    for (const call of mocks.cardElementContent.mock.calls) {
      expect(call[0].path.element_id).toBe('streaming_content');
      expect(call[0].data.content).toMatch(/中断/);
    }

    // streaming_mode flipped off
    for (const call of mocks.cardSettings.mock.calls) {
      const settings = JSON.parse(call[0].data.settings);
      expect(settings.streaming_mode).toBe(false);
    }

    // Rows cleared from the in-flight table — next boot won't re-attempt
    expect(getInFlightCards()).toHaveLength(0);
  });

  it('drops a row even when its recovery API call fails (no infinite restart loop)', async () => {
    recordInFlightCard({
      cardId: 'card_stuck',
      chatId: 'oc_1',
      messageId: null,
    });
    const cardElementContent = vi.fn(async () => {
      throw new Error('CardKit returned 400 — card was deleted');
    });
    const { client } = buildClient({ cardElementContent });

    const result = await reconcileInFlightCards(client);
    expect(result).toEqual({ scanned: 1, recovered: 0, failed: 1 });
    expect(getInFlightCards()).toHaveLength(0);
  });
});
