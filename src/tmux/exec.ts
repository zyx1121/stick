import type { ToolError } from "../core/result.ts";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one tmux invocation (which may hold several commands joined by ";") on a host. */
export type Exec = (host: string | undefined, args: string[], stdin?: string) => Promise<ExecResult>;

export class TmuxError extends Error {
  constructor(readonly error: ToolError) {
    super(error.message);
  }
}

/** An SSH alias, user@host or address. Never starts with "-", so it cannot become an ssh option. */
export const HOST_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._@:-]*$/;

/** Quote one word for a POSIX shell. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_\/.,:=@%+-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The argv that runs tmux: directly for this machine, through ssh for a host. */
export function commandFor(host: string | undefined, args: string[], socket?: string): string[] {
  const tmux = ["tmux", ...(socket ? ["-L", socket] : []), ...args];
  if (!host) return tmux;
  return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, "--", tmux.map(shellQuote).join(" ")];
}

/** Turn a failed invocation into the error envelope. */
export function classify(host: string | undefined, result: ExecResult): ToolError {
  const where = host ?? "this machine";
  const stderr = result.stderr.trim();
  if (host && result.code === 255) {
    return { code: "unreachable", message: `ssh to ${host} failed.`, why: stderr, hint: `Check that \`ssh ${host}\` works without a password prompt.` };
  }
  if (result.code === 127 || /command not found|not found: tmux/.test(stderr)) {
    return { code: "tmux_missing", message: `tmux is not installed on ${where}, or not on the PATH of a non-interactive shell.`, why: stderr, hint: "Install tmux there, or pick another host." };
  }
  if (/no server running|can't find|no such (session|window|pane)|session not found|window not found|pane not found/i.test(stderr)) {
    return { code: "not_found", message: `No such tmux session, window or pane on ${where}.`, why: stderr, hint: "Call tmux_list to see the targets." };
  }
  if (/duplicate session/.test(stderr)) {
    return { code: "exists", message: "A session with that name already exists.", why: stderr, hint: "Use it as the target, or pick another name." };
  }
  return { code: "upstream_error", message: `tmux failed on ${where} (exit ${result.code}).`, why: stderr };
}

export function spawnExec(socket?: string): Exec {
  return async (host, args, stdin) => {
    const proc = Bun.spawn(commandFor(host, args, socket), {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  };
}

/** Run and throw the envelope on failure. */
export async function tmux(exec: Exec, host: string | undefined, args: string[], stdin?: string): Promise<string> {
  const result = await exec(host, args, stdin);
  if (result.code !== 0) throw new TmuxError(classify(host, result));
  return result.stdout;
}
