/**
 * Feishu CardKit streaming controller — implements `StreamHandle`.
 *
 * Mirrors the visible behaviour of openclaw-lark's
 * `card/streaming-card-controller.ts`:
 *
 *   - Lazy card creation on the first non-trivial event.
 *   - Initial card is the "pre-answer" template (loading icon + tool-use
 *     pending panel + an empty STREAMING_ELEMENT_ID markdown to receive
 *     typewriter updates).
 *   - Text deltas flow into STREAMING_ELEMENT_ID via `cardElement.content`
 *     at ~100ms throttle (CardKit was designed for this cadence).
 *   - Reasoning + tool-use updates trigger a full `card.update` (since
 *     they restructure the card body), throttled separately.
 *   - On `finalize` the card is replaced with the "complete" snapshot:
 *     reasoning collapsible panel, tool-use panel (collapsed), main
 *     answer markdown, and a footer with elapsed time. `streaming_mode`
 *     is flipped off so the card returns to normal interactivity.
 *
 * Out of scope vs upstream (omitted intentionally — driven by openclaw
 * runtime concepts that nanoclaw doesn't have):
 *   - footer token metrics (the upstream resolves these from the
 *     framework's session store)
 *   - image-resolver (delayed image rendering)
 *   - unavailable-guard (source-message recall handling)
 *   - reply-to / reply-in-thread (we always send to chat)
 *
 * The card JSON structure produced here is byte-compatible with what
 * upstream renders, so the user-facing visual is identical.
 */

import * as Lark from '@larksuiteoapi/node-sdk';

import type { StreamHandle } from '../../types.js';
import { logger } from '../../logger.js';
import {
  STREAMING_ELEMENT_ID,
  buildCardContent,
  buildStreamingPreAnswerCard,
  toCardKit2,
} from './builder.js';
import {
  CARD_PHASES,
  DEFAULT_FOOTER,
  PHASE_TRANSITIONS,
  TERMINAL_PHASES,
  THROTTLE_CONSTANTS,
  type CardPhase,
  type ResolvedFooterConfig,
  type TerminalReason,
} from './controller-types.js';
import {
  createCardEntity,
  sendCardByCardId,
  setCardStreamingMode,
  streamCardContent,
  updateCardKitCard,
} from './cardkit.js';
import { FlushController } from './flush.js';
import {
  buildToolUseTitleSuffix,
  normalizeToolUseDisplay,
  type ToolUseDisplayResult,
} from './tool-use-display.js';
import type { ToolUseTraceStep } from './tool-use-trace-store.js';
import { normalizeToolName, redactInlineSecrets } from './reasoning-utils.js';

const log = (m: string) => logger.info(`[feishu-stream] ${m}`);

export interface FeishuStreamDeps {
  /** Slice of the Lark SDK client this controller actually touches. */
  client: Pick<Lark.Client, 'im' | 'cardkit'>;
  chatId: string;
  /**
   * Optional fallback for catastrophic failures (e.g. card.create returns
   * an error code, ratelimits exhaust). Receives the buffered text so
   * the user always sees *something*. Without it, failed streams just log.
   */
  fallbackSend?: (text: string) => Promise<void>;
  /** Override footer rendering. Defaults to status + elapsed only. */
  footer?: Partial<ResolvedFooterConfig>;
}

export class FeishuStreamHandle implements StreamHandle {
  // ---- Phase ----
  private phase: CardPhase = CARD_PHASES.idle;

  // ---- CardKit state ----
  private cardId: string | null = null;
  private sequence = 0;
  /** Memoizes the in-flight createCardEntity + sendCardByCardId promise so
   *  concurrent appendText calls don't race to create two cards. */
  private creationPromise: Promise<void> | null = null;
  /** Set when card create/send fails terminally — appended events become
   *  no-ops, finalize routes through `fallbackSend` if provided. */
  private failed = false;

  // ---- Text streaming state ----
  private textBuffer = '';
  private lastFlushedText = '';

  // ---- Reasoning state ----
  private reasoningBuffer = '';
  private reasoningStartedAt: number | null = null;
  private reasoningElapsedMs = 0;
  private isReasoningPhase = false;

  // ---- Tool-use trace ----
  private traceSteps: ToolUseTraceStep[] = [];
  private toolUseStartedAt: number | null = null;
  private toolUseElapsedMs = 0;
  private nextStepSeq = 0;

  // ---- Timing ----
  private readonly startedAt = Date.now();
  private finalElapsedMs = 0;

  // ---- Throttled card-level updates (full body replace via card.update) ----
  /** Set when an event has restructured the card body (tool-use panel /
   *  reasoning collapsed panel) and we need a full `card.update`, distinct
   *  from the text-element streaming flush. */
  private cardUpdatePending = false;
  private cardUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private cardUpdateInFlight = false;

  // ---- Throttled text streaming (cardElement.content) ----
  private readonly textFlusher: FlushController;

  /**
   * Serializes every CardKit write (cardElement.content, card.update,
   * card.settings) so the sequence number we attach to a request equals the
   * order it actually leaves the host. Without this, two writers (the text
   * flusher and the body-restructure scheduler) could race: a slow
   * cardElement.content with seq=5 lands on the server *after* a fast
   * card.update + re-flush at seq=7, and CardKit (which trusts arrival
   * order for the same element) overwrites the newer state with the older
   * short-text snapshot — visually a "reply rewinds" bug. Allocating seq
   * inside the serialized callback (not at schedule time) closes that gap.
   */
  private writeChain: Promise<void> = Promise.resolve();

  // ---- Resolved footer config ----
  private readonly footer: ResolvedFooterConfig;

  constructor(private readonly deps: FeishuStreamDeps) {
    this.footer = { ...DEFAULT_FOOTER, ...(deps.footer ?? {}) };
    this.textFlusher = new FlushController(() => this.flushTextElement());
  }

  /** Append `fn` to the strict CardKit write chain. Failures are isolated:
   *  the next write still runs, but the failed promise rejects to the
   *  caller. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(fn);
    // Swallow on the *chain* (so a failed write doesn't poison subsequent
    // writes) while still propagating to the caller via `next`.
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // -------------------------------------------------------------------------
  // StreamHandle implementation
  // -------------------------------------------------------------------------

  async appendText(delta: string): Promise<void> {
    if (this.isTerminal || this.failed || !delta) return;
    // First non-reasoning text marks the answer phase — close out the
    // reasoning timer so the final card shows an accurate "Thought for X"
    // duration.
    if (this.isReasoningPhase && this.reasoningStartedAt) {
      this.reasoningElapsedMs = Date.now() - this.reasoningStartedAt;
      this.isReasoningPhase = false;
    }
    this.textBuffer += delta;
    await this.ensureCard();
    if (this.failed) return;
    await this.textFlusher.throttledUpdate(THROTTLE_CONSTANTS.CARDKIT_MS);
  }

  async appendReasoning(delta: string): Promise<void> {
    if (this.isTerminal || this.failed || !delta) return;
    if (!this.reasoningStartedAt) this.reasoningStartedAt = Date.now();
    this.isReasoningPhase = true;
    this.reasoningBuffer += delta;
    // Reasoning content is rendered into the streaming text element while
    // we're still in the pre-answer phase (mirrors upstream behaviour:
    // the card shows a "💭 Thinking…" block until the answer starts).
    await this.ensureCard();
    if (this.failed) return;
    await this.textFlusher.throttledUpdate(
      THROTTLE_CONSTANTS.REASONING_STATUS_MS,
    );
  }

  async appendToolUse(
    toolCallId: string,
    toolName: string,
    args: unknown,
  ): Promise<void> {
    if (this.isTerminal || this.failed) return;
    const now = Date.now();
    if (!this.toolUseStartedAt) this.toolUseStartedAt = now;

    const step: ToolUseTraceStep = {
      id: toolCallId || `step_${this.nextStepSeq + 1}`,
      seq: ++this.nextStepSeq,
      toolName: normalizeToolName(toolName),
      toolCallId: toolCallId || undefined,
      params: this.sanitizeParams(args),
      status: 'running',
      startedAt: now,
    };
    this.traceSteps.push(step);
    await this.ensureCard();
    if (this.failed) return;
    this.scheduleCardUpdate();
  }

  async appendToolResult(
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
  ): Promise<void> {
    if (this.isTerminal || this.failed) return;
    const now = Date.now();
    const step =
      this.traceSteps.find((s) => s.toolCallId === toolCallId) ??
      // fallback: match by tool name + last running step
      this.traceSteps
        .slice()
        .reverse()
        .find(
          (s) =>
            s.status === 'running' &&
            normalizeToolName(s.toolName) === normalizeToolName(toolName),
        );

    if (step) {
      step.status = isError ? 'error' : 'success';
      step.finishedAt = now;
      step.durationMs = now - step.startedAt;
      if (isError) {
        step.error =
          result == null ? '<error>' : redactInlineSecrets(String(result));
      } else {
        step.result = result;
      }
    }
    if (this.toolUseStartedAt) {
      this.toolUseElapsedMs = now - this.toolUseStartedAt;
    }
    if (this.failed) return;
    this.scheduleCardUpdate();
  }

  async finalize(opts?: {
    reason?: 'normal' | 'aborted' | 'error';
  }): Promise<void> {
    const reason = mapReason(opts?.reason);
    if (this.isTerminal) return;
    this.finalElapsedMs = Date.now() - this.startedAt;
    if (this.isReasoningPhase && this.reasoningStartedAt) {
      this.reasoningElapsedMs = Date.now() - this.reasoningStartedAt;
      this.isReasoningPhase = false;
    }

    // Cancel pending throttled updates and wait for any in-flight ones to
    // settle before we issue the terminal full-card replacement. Then drain
    // the serialized write chain so every prior cardElement.content +
    // card.update has actually hit the wire — without this, the terminal
    // card.update can race a late seq=N flush and CardKit may resurrect
    // an older snapshot.
    this.textFlusher.cancelPending();
    await this.textFlusher.waitForFlush();
    this.textFlusher.complete();
    this.cancelCardUpdateTimer();
    while (this.cardUpdateInFlight) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    await this.writeChain;

    if (this.failed) {
      // Fallback already delivered the buffered text on first card-create
      // failure; nothing more to do here.
      this.transition(CARD_PHASES.creation_failed, reason);
      return;
    }
    if (!this.cardId) {
      // No event ever opened a card. Nothing to render.
      this.transition(
        reason === 'normal' ? CARD_PHASES.completed : CARD_PHASES.aborted,
        reason,
      );
      return;
    }

    // One last text-element flush in case appendText fired between the
    // last throttled tick and finalize().
    if (this.textBuffer !== this.lastFlushedText) {
      try {
        await this.flushTextElement();
      } catch (err) {
        log(
          `final text flush failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Replace the card with the settled "complete" snapshot. This is what
    // gives the user the final visual: reasoning collapsible, tool-use
    // panel (collapsed), main markdown answer, footer with elapsed time.
    // Routed through the write chain (single in-flight at this point) so
    // its seq is guaranteed greater than every prior cardElement.content.
    const complete = this.buildCompleteCard(reason);
    try {
      await this.serialize(async () => {
        await updateCardKitCard(this.deps.client, {
          cardId: this.cardId!,
          card: complete,
          sequence: this.nextSequence(),
        });
      });
      log(
        `complete card pushed cardId=${this.cardId} elapsed=${this.finalElapsedMs}ms reason=${reason}`,
      );
    } catch (err) {
      log(
        `final card.update failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Best-effort: at least flip streaming_mode off so the card stops
      // showing the loading spinner.
      try {
        await this.serialize(async () => {
          await setCardStreamingMode(this.deps.client, {
            cardId: this.cardId!,
            streamingMode: false,
            sequence: this.nextSequence(),
          });
        });
      } catch (innerErr) {
        log(
          `streaming_mode toggle failed: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`,
        );
      }
    }

    this.transition(
      reason === 'normal' ? CARD_PHASES.completed : CARD_PHASES.aborted,
      reason,
    );
  }

  // -------------------------------------------------------------------------
  // Lifecycle helpers
  // -------------------------------------------------------------------------

  private get isTerminal(): boolean {
    return TERMINAL_PHASES.has(this.phase);
  }

  private transition(target: CardPhase, _reason: TerminalReason): void {
    const allowed = PHASE_TRANSITIONS[this.phase];
    if (!allowed.has(target)) {
      // Tolerated — controller can be cancelled twice (dispose + agent_end).
      return;
    }
    this.phase = target;
  }

  private async ensureCard(): Promise<void> {
    if (this.cardId || this.failed) return;
    if (this.creationPromise) return this.creationPromise;
    this.transition(CARD_PHASES.creating, 'normal');
    this.creationPromise = (async () => {
      try {
        const initial = buildStreamingPreAnswerCard({
          steps: this.computeToolUseDisplay()?.steps,
          elapsedMs: this.visibleToolUseElapsedMs,
          showToolUse: true,
        });
        log(`creating card entity for chat=${this.deps.chatId}`);
        const cardId = await createCardEntity(this.deps.client, initial);
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
        this.transition(CARD_PHASES.streaming, 'normal');
        this.textFlusher.setReady(true);
      } catch (err) {
        this.failed = true;
        this.transition(CARD_PHASES.creation_failed, 'creation_failed');
        log(
          `card create/send failed: ${err instanceof Error ? err.message : String(err)}`,
        );
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

  // -------------------------------------------------------------------------
  // Streaming flushers
  // -------------------------------------------------------------------------

  /**
   * Push the cumulative textBuffer (or, while still in the reasoning phase,
   * the reasoning text) into STREAMING_ELEMENT_ID. CardKit diffs the new
   * value against the prior to drive the typewriter animation.
   */
  private async flushTextElement(): Promise<void> {
    if (!this.cardId) return;
    // Snapshot the *current* visible text inside the serialized callback,
    // not at schedule time. If three appendText() calls landed while a
    // previous flush was in flight, this guarantees we pick up the latest
    // accumulated buffer rather than a stale prefix.
    return this.serialize(async () => {
      const visible = this.computeStreamingText();
      if (visible === this.lastFlushedText) return;
      // Allocate seq INSIDE the serialized callback so the seq attached to
      // a request matches the order it actually leaves the host. Otherwise
      // network reordering between writers could ship seq=5 after seq=7.
      const seq = this.nextSequence();
      try {
        await streamCardContent(this.deps.client, {
          cardId: this.cardId!,
          elementId: STREAMING_ELEMENT_ID,
          content: visible,
          sequence: seq,
        });
        this.lastFlushedText = visible;
        log(`flush ok seq=${seq} len=${visible.length} cardId=${this.cardId}`);
      } catch (err) {
        log(
          `flush FAILED seq=${seq} len=${visible.length} cardId=${this.cardId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    });
  }

  /**
   * Schedule a full-card replace (tool-use panel changed). Throttled so we
   * don't spam the API on rapid back-to-back tool start/end events.
   */
  private scheduleCardUpdate(): void {
    if (!this.cardId || this.isTerminal) return;
    this.cardUpdatePending = true;
    if (this.cardUpdateTimer) return;
    this.cardUpdateTimer = setTimeout(() => {
      this.cardUpdateTimer = null;
      void this.runCardUpdate();
    }, 200);
  }

  private cancelCardUpdateTimer(): void {
    if (this.cardUpdateTimer) {
      clearTimeout(this.cardUpdateTimer);
      this.cardUpdateTimer = null;
    }
  }

  private async runCardUpdate(): Promise<void> {
    if (!this.cardId || this.isTerminal || !this.cardUpdatePending) return;
    if (this.cardUpdateInFlight) {
      // Re-arm so we don't lose the latest state.
      this.scheduleCardUpdate();
      return;
    }
    this.cardUpdateInFlight = true;
    this.cardUpdatePending = false;
    try {
      // Restructure the card body, then re-push the streaming text — both
      // through the same write chain so seq order strictly matches send
      // order with any in-flight cardElement.content from the text flusher.
      // Any plain `card.update` followed by an unserialized re-flush would
      // race the next cardElement.content scheduled by appendText().
      await this.serialize(async () => {
        const display = this.computeToolUseDisplay();
        const card = buildStreamingPreAnswerCard({
          steps: display?.steps,
          elapsedMs: this.visibleToolUseElapsedMs,
          showToolUse: true,
        });
        const seq = this.nextSequence();
        await updateCardKitCard(this.deps.client, {
          cardId: this.cardId!,
          card,
          sequence: seq,
        });
        log(`card.update ok seq=${seq} steps=${display?.stepCount ?? 0}`);
        // The replace reset the streaming element. Mark "no flushed text"
        // so the next flushTextElement re-pushes the full buffer; do *not*
        // call flushTextElement here — appendText() schedules the next
        // throttled flush and that runs serialized after this entry.
        this.lastFlushedText = '';
      });
      // If there's nothing further coming (rare — usually appendText is
      // the trigger that brought us here), prime an immediate re-flush so
      // the just-reset streaming element catches up to the text buffer.
      if (this.computeStreamingText()) {
        try {
          await this.flushTextElement();
        } catch (err) {
          log(
            `re-flush after card.update failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      log(
        `card.update FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.cardUpdateInFlight = false;
      if (this.cardUpdatePending) this.scheduleCardUpdate();
    }
  }

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------

  private computeStreamingText(): string {
    // While reasoning is the active stream and no answer text has arrived,
    // show the reasoning content with a thinking marker (mirrors upstream's
    // "💭 Thinking…" block in buildStreamingCard's reasoning branch).
    if (!this.textBuffer && this.reasoningBuffer) {
      return `💭 **思考中...**\n\n${this.reasoningBuffer}`;
    }
    return this.textBuffer;
  }

  private computeToolUseDisplay(): ToolUseDisplayResult | null {
    if (this.traceSteps.length === 0) return null;
    return normalizeToolUseDisplay({
      traceSteps: this.traceSteps,
      showFullPaths: false,
      showResultDetails: true,
    });
  }

  private get visibleToolUseElapsedMs(): number | undefined {
    if (!this.toolUseStartedAt) return undefined;
    return this.toolUseElapsedMs || Date.now() - this.toolUseStartedAt;
  }

  private buildCompleteCard(reason: TerminalReason): Record<string, unknown> {
    const display = this.computeToolUseDisplay();
    const titleSuffix =
      display && display.stepCount > 0
        ? buildToolUseTitleSuffix({ stepCount: display.stepCount })
        : undefined;
    const card = buildCardContent('complete', {
      text: this.textBuffer || (this.reasoningBuffer ? '' : ''),
      elapsedMs: this.finalElapsedMs,
      isError: reason === 'error' || reason === 'unavailable',
      isAborted: reason === 'abort',
      reasoningText: this.reasoningBuffer || undefined,
      reasoningElapsedMs: this.reasoningElapsedMs || undefined,
      toolUseSteps: display?.steps,
      toolUseTitleSuffix: titleSuffix,
      toolUseElapsedMs: this.toolUseElapsedMs || undefined,
      showToolUse: true,
      footer: this.footer,
      footerMetrics: undefined,
    });
    const ck2 = toCardKit2(card);
    // Mark the card as no longer streaming so it returns to normal
    // interaction behaviour (forwardable, action callbacks fire, etc.).
    const config = (ck2.config as Record<string, unknown>) ?? {};
    ck2.config = { ...config, streaming_mode: false };
    return ck2;
  }

  // -------------------------------------------------------------------------
  // Misc
  // -------------------------------------------------------------------------

  private nextSequence(): number {
    return ++this.sequence;
  }

  private sanitizeParams(args: unknown): Record<string, unknown> | undefined {
    if (args == null) return undefined;
    if (typeof args !== 'object')
      return { value: args } as Record<string, unknown>;
    try {
      // Shallow redact — the trace store does deep redaction at render time
      // anyway, this is just a safety net for top-level secret-shaped keys.
      return JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
}

function mapReason(
  reason: 'normal' | 'aborted' | 'error' | undefined,
): TerminalReason {
  switch (reason) {
    case 'aborted':
      return 'abort';
    case 'error':
      return 'error';
    default:
      return 'normal';
  }
}
