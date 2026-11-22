import { TmuxError, tmux, type Exec } from "./exec.ts";

const SEP = "\x1f";
const FIELDS = [
  "session_name", "window_index", "window_name", "pane_index", "pane_id",
  "pane_current_command", "pane_current_path", "pane_active", "pane_dead", "pane_in_mode", "session_attached",
] as const;
export const PANE_FORMAT = FIELDS.map((field) => `#{${field}}`).join(SEP);

export interface Pane {
  target: string;
  pane_id: string;
  session: string;
  window: string;
  command: string;
  path: string;
  active: boolean;
  dead: boolean;
  in_mode: boolean;
  attached: boolean;
}

export function parsePane(line: string): Pane {
  const v = line.split(SEP);
  return {
    target: `${v[0]}:${v[1]}.${v[3]}`,
    pane_id: v[4] ?? "",
    session: v[0] ?? "",
    window: v[2] ?? "",
    command: v[5] ?? "",
    path: v[6] ?? "",
    active: v[7] === "1",
    dead: v[8] === "1",
    in_mode: v[9] === "1",
    attached: (v[10] ?? "0") !== "0",
  };
}

export async function paneInfo(exec: Exec, host: string | undefined, target: string): Promise<Pane> {
  const out = await tmux(exec, host, ["display-message", "-p", "-t", target, PANE_FORMAT]);
  return parsePane(out.replace(/\n$/, ""));
}

const SHELLS = new Set(["bash", "zsh", "sh", "dash", "ksh", "mksh", "ash", "busybox"]);

/** True when the pane sits at a POSIX shell prompt (login shells show as "-zsh"). */
export function isShell(command: string): boolean {
  return SHELLS.has(command.replace(/^-/, ""));
}

/** Capture the last `lines` lines of a pane, wrapped lines joined, trailing blank lines dropped. */
export async function capture(exec: Exec, host: string | undefined, target: string, lines?: number): Promise<string[]> {
  const start = lines === undefined ? "-" : String(-lines);
  const out = await tmux(exec, host, ["capture-pane", "-p", "-J", "-t", target, "-S", start]);
  const rows = out.split("\n").map((row) => row.trimEnd());
  while (rows.length && rows[rows.length - 1] === "") rows.pop();
  // -S counts back from the top of the screen, so the capture also holds the whole screen.
  return lines === undefined ? rows : rows.slice(-lines);
}

export function newRunId(): string {
  return crypto.getRandomValues(new Uint8Array(5)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
}

const markers = (id: string) => ({ start: `KILO_${id}_START`, end: `KILO_${id}_END` });

/**
 * The text pasted into the shell. The command sits in a brace group so that
 * several lines run as one unit and `$?` is its exit status. The markers are
 * printed by printf, so the echoed command line never matches them on its own.
 * The leading space keeps it out of shell history where ignorespace is on.
 */
export function wrapCommand(id: string, command: string): string {
  const m = markers(id);
  return ` printf '%s\\n' ${m.start}; { ${command}\n}; printf '\\n%s %s\\n' ${m.end} "$?"`;
}

export interface RunOutput {
  /** Exit status when the end marker was seen, otherwise null. */
  exit_code: number | null;
  /** Whether the start marker was still in the history. */
  started: boolean;
  lines: string[];
}

/** Find a run's output between its markers in captured pane lines. */
export function extractRun(id: string, rows: string[]): RunOutput {
  const m = markers(id);
  const endPattern = new RegExp(`^${m.end} (\\d+)$`);
  let start = -1;
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i] === m.start) { start = i; break; }
  let end = -1;
  let code: number | null = null;
  for (let i = Math.max(start, 0); i < rows.length; i++) {
    const hit = endPattern.exec(rows[i]!);
    if (hit) { end = i; code = Number(hit[1]); break; }
  }
  const lines = rows.slice(start + 1, end === -1 ? rows.length : end);
  // The end marker starts with a newline: drop the empty line it adds after output that already ended in one.
  if (end !== -1 && lines.length && lines[lines.length - 1] === "") lines.pop();
  return { exit_code: code, started: start !== -1, lines };
}

/** Paste text into a pane as one bracketed paste, then press Enter. Shell plugins that auto-pair braces never see keystrokes. */
export async function pasteAndEnter(exec: Exec, host: string | undefined, target: string, text: string, enter = true): Promise<void> {
  const buffer = `kilo-${newRunId()}`;
  const args = ["load-buffer", "-b", buffer, "-", ";", "paste-buffer", "-p", "-d", "-b", buffer, "-t", target];
  if (enter) args.push(";", "send-keys", "-t", target, "Enter");
  await tmux(exec, host, args, text);
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) };

/**
 * Poll until `done` returns a value or the deadline passes. The interval grows
 * from 50 ms to 1 s, so a quick command answers fast and a long one costs few calls.
 */
export async function poll<T>(clock: Clock, timeoutMs: number, check: () => Promise<T | undefined>): Promise<T | undefined> {
  const deadline = clock.now() + timeoutMs;
  let interval = 50;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (clock.now() >= deadline) return undefined;
    await clock.sleep(Math.min(interval, Math.max(deadline - clock.now(), 0)));
    interval = Math.min(interval * 2, 1000);
  }
}

export function busyError(pane: Pane): TmuxError {
  return new TmuxError({
    code: "busy",
    message: `Pane ${pane.target} is running ${pane.command}, not sitting at a shell prompt.`,
    hint: "Wait for it with tmux_wait, read it with tmux_read, or stop it with tmux_send keys [\"C-c\"].",
  });
}
