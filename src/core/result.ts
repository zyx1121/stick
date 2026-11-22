export interface ToolRunResult {
  structuredContent: Record<string, unknown>;
  isError: boolean;
}

export interface ToolError {
  /** Actionable code: invalid_input, unreachable, tmux_missing, not_found, exists, busy, dead, upstream_error. */
  code: string;
  message: string;
  /** What actually went wrong underneath. */
  why?: string | null;
  /** The next action to take. */
  hint?: string | null;
}

export function ok(data: unknown, metadata?: Record<string, unknown>): ToolRunResult {
  return { isError: false, structuredContent: metadata ? { data, metadata } : { data } };
}

export function fail(error: ToolError): ToolRunResult {
  return { isError: true, structuredContent: { error } };
}

export function mcpResult(result: ToolRunResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result.structuredContent) }],
    structuredContent: result.structuredContent,
    isError: result.isError,
  };
}
