export interface ToolUseTraceStep {
  id: string;
  seq: number;
  toolName: string;
  toolCallId?: string;
  runId?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
  status: 'running' | 'success' | 'error';
  startedAt: number;
  finishedAt?: number;
}
