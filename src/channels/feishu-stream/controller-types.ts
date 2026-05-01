/**
 * Type definitions and constants for the Feishu streaming card controller.
 *
 * Subset of openclaw-lark/src/card/reply-dispatcher-types.ts that doesn't
 * depend on `openclaw/plugin-sdk` — the dispatch glue (ReplyDispatcher,
 * ReplyPayload, ClawdbotConfig) is replaced in nanoclaw by the StreamHandle
 * protocol, so only the state machine + render state types come over.
 */

// ---------------------------------------------------------------------------
// CardPhase — explicit state machine replacing boolean flags
// ---------------------------------------------------------------------------

export const CARD_PHASES = {
  idle: 'idle',
  creating: 'creating',
  streaming: 'streaming',
  completed: 'completed',
  aborted: 'aborted',
  terminated: 'terminated',
  creation_failed: 'creation_failed',
} as const;

export type CardPhase = (typeof CARD_PHASES)[keyof typeof CARD_PHASES];

export const TERMINAL_PHASES: ReadonlySet<CardPhase> = new Set([
  'completed',
  'aborted',
  'terminated',
  'creation_failed',
]);

export type TerminalReason =
  | 'normal'
  | 'error'
  | 'abort'
  | 'unavailable'
  | 'creation_failed';

export const PHASE_TRANSITIONS: Record<CardPhase, ReadonlySet<CardPhase>> = {
  idle: new Set(['creating', 'aborted', 'terminated']),
  creating: new Set(['streaming', 'creation_failed', 'aborted', 'terminated']),
  streaming: new Set(['completed', 'aborted', 'terminated']),
  completed: new Set(),
  aborted: new Set(),
  terminated: new Set(),
  creation_failed: new Set(),
};

// ---------------------------------------------------------------------------
// Structured state aggregates
// ---------------------------------------------------------------------------

export interface ReasoningState {
  accumulatedReasoningText: string;
  reasoningStartTime: number | null;
  reasoningElapsedMs: number;
  isReasoningPhase: boolean;
}

export interface ToolUseState {
  startedAt: number | null;
  elapsedMs: number;
  isActive: boolean;
}

export interface StreamingTextState {
  accumulatedText: string;
  completedText: string;
  streamingPrefix: string;
  lastPartialText: string;
  lastFlushedText: string;
}

export interface CardKitState {
  cardKitCardId: string | null;
  originalCardKitCardId: string | null;
  cardKitSequence: number;
  cardMessageId: string | null;
}

// ---------------------------------------------------------------------------
// Throttle constants
// ---------------------------------------------------------------------------

export const THROTTLE_CONSTANTS = {
  CARDKIT_MS: 100,
  PATCH_MS: 1500,
  LONG_GAP_THRESHOLD_MS: 2000,
  BATCH_AFTER_GAP_MS: 300,
  REASONING_STATUS_MS: 1500,
} as const;

export const EMPTY_REPLY_FALLBACK_TEXT = 'Done.';

// ---------------------------------------------------------------------------
// Footer metrics
// ---------------------------------------------------------------------------

export interface FooterSessionMetrics {
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  contextTokens?: number;
  model?: string;
}

/**
 * Resolved footer rendering preferences. Mirrors openclaw-lark's
 * `Required<FeishuFooterConfig>` so the ported builder.ts can stay
 * unchanged where it consults footer toggles.
 */
export interface ResolvedFooterConfig {
  status: boolean;
  elapsed: boolean;
  tokens: boolean;
  cache: boolean;
  context: boolean;
  model: boolean;
}

export const DEFAULT_FOOTER: ResolvedFooterConfig = {
  status: true,
  elapsed: true,
  tokens: false,
  cache: false,
  context: false,
  model: false,
};
