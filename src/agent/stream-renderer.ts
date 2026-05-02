// src/agent/stream-renderer.ts
//
// Bridges pi's AgentSession events to a per-prompt channel StreamHandle.
// Owns the lazy stream open, ordering of appends/finalize via SerialChain,
// and the per-turn endTurn cleanup. Extracted from run.ts so the agent
// orchestration there isn't entangled with channel rendering details.
//
// One renderer is created per AgentSession (i.e. per chat). It wires
// itself to the session via session.subscribe at construction time and
// stays alive for the session's lifetime; abort() drains any in-flight
// writes and finalizes the open stream (used by SessionPool dispose).

import type {
  AgentSession,
  AgentSessionEvent,
} from '@mariozechner/pi-coding-agent';
import { errMsg, logger } from '../logger.js';
import type { StreamHandle } from '../types.js';
import { SerialChain } from '../util/serial-chain.js';

const log = (m: string) => logger.info(`[stream-renderer] ${m}`);

export interface StreamRendererDeps {
  session: AgentSession;
  /** Lazily resolves a fresh StreamHandle for the chat. Called once per
   *  turn on the first event that wants streaming output. */
  openStream: () => Promise<StreamHandle>;
}

export class StreamRenderer {
  private streamHandle: StreamHandle | null = null;
  /** Memoizes "we already tried to open a stream this turn" — avoids
   *  retrying the channel on every event when openStream throws. Cleared
   *  by endTurn. */
  private streamProbed = false;
  private readonly sendChain = new SerialChain();
  private disposed = false;

  constructor(private readonly deps: StreamRendererDeps) {
    deps.session.subscribe((event) => this.handleEvent(event));
  }

  /** Drain pending writes and finalize the open stream (if any). Called
   *  by SessionPool dispose; safe to call more than once. */
  async abort(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.sendChain.drain();
    await this.endTurn('aborted');
  }

  // -- internal --------------------------------------------------------

  private handleEvent(event: AgentSessionEvent): void {
    if (this.disposed) return;
    if (event.type === 'message_update') {
      const ame = event.assistantMessageEvent;
      if (ame.type === 'text_delta') {
        this.onStream('appendText', (s) => s.appendText(ame.delta));
      } else if (ame.type === 'thinking_delta') {
        this.onStream('appendReasoning', (s) => s.appendReasoning(ame.delta));
      }
    } else if (event.type === 'tool_execution_start') {
      const { toolCallId, toolName, args } = event;
      this.onStream('appendToolUse', (s) =>
        s.appendToolUse(toolCallId, toolName, args),
      );
    } else if (event.type === 'tool_execution_end') {
      const { toolCallId, toolName, result, isError } = event;
      this.onStream('appendToolResult', (s) =>
        s.appendToolResult(toolCallId, toolName, result, isError),
      );
    } else if (event.type === 'agent_end') {
      // Finalize on agent_end (prompt boundary), NOT turn_end. A single
      // user prompt can produce multiple turns when the model takes a
      // tool-call loop; finalizing per turn would close the card
      // mid-conversation and open a fresh one for the next turn — the
      // "two cards per reply" bug.
      void this.sendChain.run(() => this.endTurn('normal'));
    }
  }

  private onStream(
    label: string,
    fn: (s: StreamHandle) => Promise<void>,
  ): void {
    void this.sendChain.run(async () => {
      const stream = await this.ensureStream();
      if (!stream) return;
      try {
        await fn(stream);
      } catch (err) {
        log(`${label} failed: ${errMsg(err)}`);
      }
    });
  }

  /**
   * Lazily open the per-turn stream on the first event that wants one.
   * Returns null (and remembers it via `streamProbed`) when the channel
   * can't supply a stream — subsequent events for that turn become no-ops
   * rather than spamming retries. The next turn re-probes after endTurn
   * clears the flag.
   */
  private async ensureStream(): Promise<StreamHandle | null> {
    if (this.streamHandle) return this.streamHandle;
    if (this.streamProbed) return null;
    this.streamProbed = true;
    try {
      this.streamHandle = await this.deps.openStream();
      return this.streamHandle;
    } catch (err) {
      log(`openStream failed: ${errMsg(err)}`);
      return null;
    }
  }

  /** Finalize the open stream (if any) and reset turn-local state. */
  private async endTurn(reason: 'normal' | 'aborted' | 'error'): Promise<void> {
    const stream = this.streamHandle;
    this.streamHandle = null;
    this.streamProbed = false;
    if (!stream) return;
    try {
      await stream.finalize({ reason });
    } catch (err) {
      log(`stream.finalize failed: ${errMsg(err)}`);
    }
  }
}
