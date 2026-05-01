/**
 * StreamHandle implementation backed by Lark CardKit's streaming card APIs.
 *
 * Lifecycle:
 *   1. First `appendText` → lazily create a card entity, send it as an
 *      `interactive` IM message in the chat, mark the FlushController ready.
 *   2. Subsequent `appendText` calls accumulate into `textBuffer` and ask
 *      the FlushController to coalesce updates within `THROTTLE_MS`.
 *   3. `finalize` cancels pending timers, runs one final flush so the user
 *      sees the full text, then flips `streaming_mode` off and replaces the
 *      card so it returns to normal interaction behaviour.
 *
 * Reasoning / tool-use events are accepted but not yet rendered — the first
 * cut focuses on getting text streaming on screen. They'll be rendered in a
 * follow-up milestone alongside collapsible panels and tool-call cards.
 */

import * as Lark from '@larksuiteoapi/node-sdk';

import type { StreamHandle } from '../../types.js';
import { logger } from '../../logger.js';
import {
  STREAMING_ELEMENT_ID,
  buildFinalCard,
  buildInitialCard,
} from './card.js';
import {
  createCardEntity,
  sendCardByCardId,
  setCardStreamingMode,
  streamCardContent,
  updateCardKitCard,
} from './cardkit.js';
import { FlushController } from './flush.js';

const THROTTLE_MS = 500;
const log = (m: string) => logger.info(`[feishu-stream] ${m}`);

export interface FeishuStreamDeps {
  /** Slice of the Lark SDK client this handle actually touches — IM (to send
   *  the carrier message) and CardKit (to create + stream the card entity). */
  client: Pick<Lark.Client, 'im' | 'cardkit'>;
  chatId: string;
  /**
   * Optional fallback used by the channel when card creation fails. Receives
   * the buffered text and is expected to deliver it as a normal message.
   * Without a fallback, failed streams just log and drop the output.
   */
  fallbackSend?: (text: string) => Promise<void>;
}

export class FeishuStreamHandle implements StreamHandle {
  private textBuffer = '';
  private cardId: string | null = null;
  private sequence = 0;
  private finalized = false;
  private creationPromise: Promise<void> | null = null;
  private failed = false;
  private readonly flusher: FlushController;

  constructor(private readonly deps: FeishuStreamDeps) {
    this.flusher = new FlushController(() => this.doFlush());
  }

  async appendText(delta: string): Promise<void> {
    if (this.finalized || this.failed || !delta) return;
    this.textBuffer += delta;
    await this.ensureCard();
    if (this.failed) return;
    await this.flusher.throttledUpdate(THROTTLE_MS);
  }

  async appendReasoning(_delta: string): Promise<void> {
    // First-cut: reasoning rendering not implemented. Accept and drop so the
    // upstream pipeline doesn't error, but don't waste an API call.
  }

  async appendToolUse(
    _toolCallId: string,
    _toolName: string,
    _args: unknown,
  ): Promise<void> {
    // Same as reasoning — deferred to the next milestone.
  }

  async appendToolResult(
    _toolCallId: string,
    _toolName: string,
    _result: unknown,
    _isError: boolean,
  ): Promise<void> {
    // Same as reasoning — deferred to the next milestone.
  }

  async finalize(opts?: {
    reason?: 'normal' | 'aborted' | 'error';
  }): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.flusher.cancelPending();
    await this.flusher.waitForFlush();
    this.flusher.complete();

    if (this.failed) {
      // Card creation never succeeded — the constructor's fallbackSend (if
      // any) already delivered the text on the first ensureCard failure.
      return;
    }
    if (!this.cardId) {
      // No text was ever appended. Nothing to render.
      return;
    }

    // Final flush so the user sees the last few characters.
    try {
      await this.doFlush();
    } catch (err) {
      log(
        `final flush failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Flip streaming_mode off + replace with the settled card so the message
    // can be forwarded / interacted with normally. Best-effort — a failure
    // here just leaves the card in streaming mode, the text is already
    // visible.
    try {
      const seq = this.nextSequence();
      await updateCardKitCard(this.deps.client, {
        cardId: this.cardId,
        card: buildFinalCard(this.textBuffer),
        sequence: seq,
      });
    } catch (err) {
      log(
        `final card.update failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      try {
        await setCardStreamingMode(this.deps.client, {
          cardId: this.cardId,
          streamingMode: false,
          sequence: this.nextSequence(),
        });
      } catch (innerErr) {
        log(
          `streaming_mode toggle failed: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`,
        );
      }
    }

    if (opts?.reason && opts.reason !== 'normal') {
      log(`stream finalized reason=${opts.reason}`);
    }
  }

  // -------------------------------------------------------------------------

  private async ensureCard(): Promise<void> {
    if (this.cardId || this.failed) return;
    if (this.creationPromise) return this.creationPromise;
    this.creationPromise = (async () => {
      try {
        log(`creating card entity for chat=${this.deps.chatId}`);
        const cardId = await createCardEntity(
          this.deps.client,
          buildInitialCard(),
        );
        log(`card created cardId=${cardId}, sending interactive message`);
        const sent = await sendCardByCardId(
          this.deps.client,
          this.deps.chatId,
          cardId,
        );
        log(
          `card sent messageId=${sent.messageId} chatId=${sent.chatId} cardId=${cardId}`,
        );
        this.cardId = cardId;
        this.flusher.setReady(true);
      } catch (err) {
        this.failed = true;
        log(
          `card create/send failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Try to deliver the text as a normal message so the user isn't left
        // waiting on a silent failure.
        if (this.deps.fallbackSend && this.textBuffer) {
          try {
            await this.deps.fallbackSend(this.textBuffer);
          } catch (sendErr) {
            log(
              `fallbackSend failed: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`,
            );
          }
        }
      }
    })();
    await this.creationPromise;
  }

  private async doFlush(): Promise<void> {
    if (!this.cardId) return;
    const seq = this.nextSequence();
    const len = this.textBuffer.length;
    try {
      await streamCardContent(this.deps.client, {
        cardId: this.cardId,
        elementId: STREAMING_ELEMENT_ID,
        content: this.textBuffer,
        sequence: seq,
      });
      log(`flush ok seq=${seq} len=${len} cardId=${this.cardId}`);
    } catch (err) {
      log(
        `flush FAILED seq=${seq} len=${len} cardId=${this.cardId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  private nextSequence(): number {
    return ++this.sequence;
  }
}
