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
import { errMsg, logger } from '../../logger.js';
import { SerialChain } from '../../util/serial-chain.js';
import {
  bumpInFlightCardSequence,
  clearInFlightCard,
  recordInFlightCard,
} from '../../db.js';
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
import {
  buildToolUseTitleSuffix,
  normalizeToolUseDisplay,
  type ToolUseDisplayResult,
} from './tool-use-display.js';
import type { ToolUseTraceStep } from './tool-use-trace-store.js';
import { normalizeToolName, redactInlineSecrets } from './reasoning-utils.js';

const log = (m: string) => logger.info(`[feishu-stream] ${m}`);

/** Hard ceiling on `finalize()` — every Feishu API call inside finalize is
 *  defensively try/caught, but if all of them genuinely hang we don't want
 *  the orchestration layer (StreamRenderer.abort, SessionPool dispose) to
 *  inherit the wait. This drops the card into a terminal state with a
 *  best-effort fallback message instead of pinning the chat forever. */
const FINALIZE_TIMEOUT_MS = 30000;

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

  // ---- Single-loop reconciler (replaces the old textFlusher +
  //      cardUpdateTimer pair) ----
  //
  // The render layer is declarative: events update internal state, and a
  // single scheduled reconcile() compares the current state against the
  // last successfully-pushed snapshot to decide which CardKit call to
  // issue (cardElement.content for text-only changes; card.update when
  // structure changes — tool steps added/finished/etc.). All pushes go
  // through `writeChain` so seq order on the wire matches dispatch order.
  /** Snapshot of what's currently rendered at STREAMING_ELEMENT_ID on the
   *  Feishu side (or, equivalently, what would be there had every prior
   *  push succeeded). Used to short-circuit no-op reconciles. */
  private lastPushedText = '';
  /** Fingerprint of the toolSteps array as last pushed. When this differs
   *  from `hashToolSteps(traceSteps)`, structure changed → card.update. */
  private lastPushedToolHash = '';
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileInProgress = false;

  /** Serializes CardKit writes; seq must be allocated inside the callback,
   *  not at schedule time, so request order matches seq order on the wire. */
  private readonly writeChain = new SerialChain();

  // ---- Resolved footer config ----
  private readonly footer: ResolvedFooterConfig;

  constructor(private readonly deps: FeishuStreamDeps) {
    this.footer = { ...DEFAULT_FOOTER, ...(deps.footer ?? {}) };
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
    this.scheduleReconcile();
  }

  async appendReasoning(delta: string): Promise<void> {
    if (this.isTerminal || this.failed || !delta) return;
    if (!this.reasoningStartedAt) this.reasoningStartedAt = Date.now();
    this.isReasoningPhase = true;
    this.reasoningBuffer += delta;
    await this.ensureCard();
    if (this.failed) return;
    this.scheduleReconcile();
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
    this.scheduleReconcile();
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
    this.scheduleReconcile();
  }

  async finalize(opts?: {
    reason?: 'normal' | 'aborted' | 'error';
  }): Promise<void> {
    if (this.isTerminal) return;
    // Cap the entire finalize in a watchdog. If any Feishu call genuinely
    // hangs past the timeout we fall through to a terminal phase and let
    // the caller continue — a stuck card must never pin SessionPool dispose
    // or the upstream message loop.
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timeout'), FINALIZE_TIMEOUT_MS);
    });
    const work = this.finalizeImpl(opts);
    try {
      const result = await Promise.race([work, timeout]);
      if (result === 'timeout') {
        log(
          `finalize timed out after ${FINALIZE_TIMEOUT_MS}ms cardId=${this.cardId ?? '<none>'}; forcing terminal state`,
        );
        // Best-effort: park the card in an aborted phase so subsequent
        // events become no-ops. The in-flight finalize keeps running in
        // the background; if it eventually succeeds, the card.update will
        // race a no-op transition. Acceptable: the user's view either way
        // converges to a terminal card.
        if (!this.isTerminal) {
          this.transition(CARD_PHASES.aborted, 'abort');
        }
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private async finalizeImpl(opts?: {
    reason?: 'normal' | 'aborted' | 'error';
  }): Promise<void> {
    const reason = mapReason(opts?.reason);
    this.finalElapsedMs = Date.now() - this.startedAt;
    if (this.isReasoningPhase && this.reasoningStartedAt) {
      this.reasoningElapsedMs = Date.now() - this.reasoningStartedAt;
      this.isReasoningPhase = false;
    }

    // Drain pending reconciles so the terminal card.update doesn't race a
    // late push (which would resurrect an older snapshot). Cancel the
    // scheduled timer first so no fresh reconcile starts while we drain.
    this.cancelReconcileTimer();
    await this.writeChain.drain();

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

    // One last reconcile in case events fired between the last scheduled
    // tick and finalize() — diff-based, so it's a no-op when nothing
    // changed.
    try {
      await this.reconcile();
    } catch (err) {
      log(`final reconcile failed: ${errMsg(err)}`);
    }

    // Replace the card with the settled "complete" snapshot. This is what
    // gives the user the final visual: reasoning collapsible, tool-use
    // panel (collapsed), main markdown answer, footer with elapsed time.
    // Routed through the write chain (single in-flight at this point) so
    // its seq is guaranteed greater than every prior cardElement.content.
    const complete = this.buildCompleteCard(reason);
    try {
      await this.writeChain.run(async () => {
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
      log(`final card.update failed: ${errMsg(err)}`);
      // Best-effort: at least flip streaming_mode off so the card stops
      // showing the loading spinner.
      try {
        await this.writeChain.run(async () => {
          await setCardStreamingMode(this.deps.client, {
            cardId: this.cardId!,
            streamingMode: false,
            sequence: this.nextSequence(),
          });
        });
      } catch (innerErr) {
        log(`streaming_mode toggle failed: ${errMsg(innerErr)}`);
      }
    }

    // Card has reached its terminal state — drop the in-flight row so the
    // boot reconciler doesn't try to "rescue" an already-finalized card on
    // the next nanoclaw start.
    if (this.cardId) {
      try {
        clearInFlightCard(this.cardId);
      } catch (err) {
        log(`clearInFlightCard failed (harmless leak): ${errMsg(err)}`);
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
        // Record before marking ready so a crash before the first flush
        // still leaves a reconcile row.
        try {
          recordInFlightCard({
            cardId,
            chatId: this.deps.chatId,
            messageId: sent.messageId || null,
          });
        } catch (err) {
          log(`recordInFlightCard failed (proceeding): ${errMsg(err)}`);
        }
        this.transition(CARD_PHASES.streaming, 'normal');
        // Card is live — kick off the first reconcile so any events that
        // queued during creation get pushed.
        this.scheduleReconcile();
      } catch (err) {
        this.failed = true;
        this.transition(CARD_PHASES.creation_failed, 'creation_failed');
        log(`card create/send failed: ${errMsg(err)}`);
        if (this.deps.fallbackSend && this.textBuffer) {
          try {
            await this.deps.fallbackSend(this.textBuffer);
          } catch (sendErr) {
            log(`fallbackSend failed: ${errMsg(sendErr)}`);
          }
        }
      }
    })();
    await this.creationPromise;
  }

  // -------------------------------------------------------------------------
  // Reconciler — diffs current state against the last pushed snapshot and
  // emits the minimal CardKit call. Replaces the old textFlusher +
  // scheduleCardUpdate / runCardUpdate triplet. Pi web-ui uses an
  // equivalent "snapshot + RAF" model; the flow here is the same idea
  // adapted for a remote API target instead of the DOM.
  // -------------------------------------------------------------------------

  private scheduleReconcile(): void {
    if (this.isTerminal || this.failed || !this.cardId) return;
    if (this.reconcileTimer) return;
    // Reasoning bursts are gentler-rated than answer text — match the old
    // REASONING_STATUS_MS cadence to avoid flooding CardKit while the
    // model is still thinking.
    const delay =
      !this.textBuffer && this.reasoningBuffer
        ? THROTTLE_CONSTANTS.REASONING_STATUS_MS
        : THROTTLE_CONSTANTS.CARDKIT_MS;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      void this.reconcile();
    }, delay);
  }

  private cancelReconcileTimer(): void {
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  /**
   * Diff the current state against the last successfully-pushed snapshot
   * and dispatch the minimal CardKit call that closes the gap. Routed
   * through writeChain so seq order matches dispatch order.
   *
   * Diff rules:
   *   • toolStep set/status changed → card.update (bundles current text)
   *   • text-only change → cardElement.content
   *   • neither → no-op
   *
   * Re-arms itself if state mutated during the dispatch (writeChain.run
   * can take 100+ ms under network slowness).
   */
  private async reconcile(): Promise<void> {
    if (this.isTerminal || this.failed || !this.cardId) return;
    if (this.reconcileInProgress) {
      // A push is already in flight; the post-push tail will re-check.
      return;
    }
    this.reconcileInProgress = true;
    try {
      await this.writeChain.run(async () => {
        if (this.isTerminal || this.failed || !this.cardId) return;
        const visibleText = this.computeStreamingText();
        const toolHash = this.hashToolSteps();
        const structureChanged = toolHash !== this.lastPushedToolHash;
        const textChanged = visibleText !== this.lastPushedText;
        if (!structureChanged && !textChanged) return;

        if (structureChanged) {
          const display = this.computeToolUseDisplay();
          const card = buildStreamingPreAnswerCard({
            steps: display?.steps,
            elapsedMs: this.visibleToolUseElapsedMs,
            showToolUse: true,
            streamingContent: visibleText,
          });
          const seq = this.nextSequence();
          await updateCardKitCard(this.deps.client, {
            cardId: this.cardId,
            card,
            sequence: seq,
          });
          this.lastPushedText = visibleText;
          this.lastPushedToolHash = toolHash;
          log(
            `card.update ok seq=${seq} steps=${display?.stepCount ?? 0} streamingLen=${visibleText.length}`,
          );
          return;
        }

        // text-only path
        const seq = this.nextSequence();
        try {
          await streamCardContent(this.deps.client, {
            cardId: this.cardId,
            elementId: STREAMING_ELEMENT_ID,
            content: visibleText,
            sequence: seq,
          });
          this.lastPushedText = visibleText;
          log(
            `flush ok seq=${seq} len=${visibleText.length} cardId=${this.cardId}`,
          );
        } catch (err) {
          log(
            `flush FAILED seq=${seq} len=${visibleText.length} cardId=${this.cardId}: ${errMsg(err)}`,
          );
          // Don't rethrow: the next reconcile will retry with a higher seq.
        }
      });
    } finally {
      this.reconcileInProgress = false;
      // If state mutated while we were pushing, schedule another pass.
      if (
        !this.isTerminal &&
        !this.failed &&
        this.cardId &&
        (this.computeStreamingText() !== this.lastPushedText ||
          this.hashToolSteps() !== this.lastPushedToolHash)
      ) {
        this.scheduleReconcile();
      }
    }
  }

  /** Compact fingerprint of the toolSteps array — captures count + each
   *  step's status so the reconciler can detect "structure changed"
   *  cheaply. Step ordering is stable (append-only) so a length+status
   *  string is sufficient. */
  private hashToolSteps(): string {
    if (this.traceSteps.length === 0) return '';
    return this.traceSteps.map((s) => `${s.id}:${s.status}`).join('|');
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
      text: this.textBuffer,
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
    const seq = ++this.sequence;
    if (this.cardId) {
      try {
        bumpInFlightCardSequence(this.cardId, seq);
      } catch {
        // Best-effort — sequence tracking is for reconcile only, not flow.
      }
    }
    return seq;
  }

  private sanitizeParams(args: unknown): Record<string, unknown> | undefined {
    if (args == null) return undefined;
    if (typeof args !== 'object')
      return { value: args } as Record<string, unknown>;
    try {
      // Snapshot now so later mutations to args don't mutate the rendered
      // trace step. Redaction happens at render time in tool-use-display.
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
