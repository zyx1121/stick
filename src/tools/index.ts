import { homedir } from "node:os";
import { z } from "zod";
import { fail, ok } from "../core/result.ts";
import { defineTool, type ToolboxTool } from "../core/tool.ts";
import { HOST_PATTERN, TmuxError, classify, tmux, type Exec } from "../tmux/exec.ts";
import {
  busyError, capture, extractRun, isShell, newRunId, paneInfo, parsePane, pasteAndEnter, poll,
  wrapCommand, PANE_FORMAT, type Clock, type Pane,
} from "../tmux/pane.ts";

const MAX_CHARS = 20000;

const host = z
  .string()
  .regex(HOST_PATTERN, "A host is an SSH alias, user@host or address.")
  .optional()
  .describe("SSH host as in ~/.ssh/config, or user@host. Omit for this machine.");
const target = z
  .string()
  .min(1)
  .describe('Pane to act on: "session", "session:window", "session:window.pane" or a pane ID such as "%3".');
const timeout = z.number().int().min(1).max(600).optional().describe("Seconds to wait. Default: 60.");

const paneSchema = z.looseObject({
  target: z.string().describe("session:window.pane"),
  pane_id: z.string().describe("Stable pane ID. Prefer it as the target for later calls."),
  session: z.string(),
  window: z.string().describe("Window name."),
  command: z.string().describe("Program in the foreground, such as zsh or vim."),
  path: z.string().describe("Working directory of that program."),
  active: z.boolean(),
  dead: z.boolean().describe("The program exited and the pane stays open."),
  in_mode: z.boolean().describe("In copy mode."),
  attached: z.boolean().describe("A person has the session open."),
});

const runSchema = z.looseObject({
  done: z.boolean().describe("The command finished within the timeout."),
  exit_code: z.number().nullable(),
  output: z.string().describe("What the command printed. Long output keeps its end."),
  truncated: z.boolean(),
  run_id: z.string().describe("Pass it to tmux_wait when done is false."),
  target: z.string().describe("Pane ID the command runs in."),
  elapsed_ms: z.number(),
});

/** Keep the end of long output: that is where errors and results are. */
function tail(lines: string[]): { output: string; truncated: boolean } {
  const text = lines.join("\n");
  return text.length <= MAX_CHARS ? { output: text, truncated: false } : { output: text.slice(-MAX_CHARS), truncated: true };
}

export function allTools(exec: Exec, clock: Clock): ToolboxTool[] {
  async function waitRun(h: string | undefined, pane: string, id: string, seconds: number) {
    const began = clock.now();
    const finished = await poll(clock, seconds * 1000, async () => {
      const recent = extractRun(id, await capture(exec, h, pane, 400));
      if (recent.exit_code === null) return undefined;
      return recent.started ? recent : extractRun(id, await capture(exec, h, pane));
    });
    const result = finished ?? extractRun(id, await capture(exec, h, pane, 400));
    const { output, truncated } = tail(result.lines);
    return {
      done: finished !== undefined,
      exit_code: result.exit_code,
      output,
      truncated: truncated || (finished !== undefined && !result.started),
      run_id: id,
      target: pane,
      elapsed_ms: clock.now() - began,
    };
  }

  const tools: ToolboxTool[] = [
    defineTool({
      name: "tmux_list",
      description: "List every tmux pane on a host: target, pane ID, foreground program, directory and state. An empty list means no tmux server runs there.",
      inputSchema: { host },
      data: z.looseObject({ panes: z.array(paneSchema) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async handler({ host: h }) {
        const result = await exec(h, ["list-panes", "-a", "-F", PANE_FORMAT]);
        if (result.code !== 0 && /no server running|error connecting/i.test(result.stderr)) return ok({ panes: [] }, { host: h ?? "local" });
        if (result.code !== 0) throw new TmuxError(classify(h, result));
        const panes = result.stdout.split("\n").filter(Boolean).map(parsePane);
        return ok({ panes }, { host: h ?? "local" });
      },
    }),

    defineTool({
      name: "tmux_new",
      description: "Start a detached tmux session with a shell and return its pane. Waits until the shell has drawn its prompt, so tmux_run can follow at once.",
      inputSchema: {
        host,
        session: z.string().regex(/^[A-Za-z0-9_-]+$/, "Letters, digits, - and _ only.").describe("Session name."),
        cwd: z.string().optional().describe("Starting directory. Default: the home directory on that host."),
      },
      data: z.looseObject({ pane: paneSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async handler({ host: h, session, cwd }) {
        const args = ["new-session", "-d", "-s", session, "-P", "-F", PANE_FORMAT];
        // A remote shell over ssh starts at home already; a local tmux would inherit this server's directory.
        const dir = cwd ?? (h ? undefined : homedir());
        if (dir) args.push("-c", dir);
        const created = parsePane((await tmux(exec, h, args)).replace(/\n$/, ""));
        await poll(clock, 5000, async () => ((await capture(exec, h, created.pane_id)).length ? true : undefined));
        return ok({ pane: await paneInfo(exec, h, created.pane_id) }, { host: h ?? "local" });
      },
    }),

    defineTool({
      name: "tmux_run",
      description:
        "Run a shell command in a pane and return its output and exit code. It pastes the command at the shell prompt, waits until it ends, and reads only that command's output. Several lines run as one unit. The pane must sit at a bash or zsh prompt; a running program gives busy. On timeout the command keeps running: call tmux_wait with the run_id.",
      inputSchema: {
        host,
        target,
        command: z.string().min(1).describe("Shell command. Several lines are allowed."),
        timeout_s: timeout,
      },
      data: runSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      async handler({ host: h, target: t, command, timeout_s }) {
        const pane = await paneInfo(exec, h, t);
        if (pane.dead) return fail({ code: "dead", message: `Pane ${pane.target} has exited.`, hint: "Start a new session with tmux_new." });
        if (pane.in_mode) await tmux(exec, h, ["send-keys", "-X", "-t", pane.pane_id, "cancel"]);
        if (!isShell(pane.command)) throw busyError(pane);
        const id = newRunId();
        await pasteAndEnter(exec, h, pane.pane_id, wrapCommand(id, command));
        return ok(await waitRun(h, pane.pane_id, id, timeout_s ?? 60), { host: h ?? "local" });
      },
    }),

    defineTool({
      name: "tmux_wait",
      description:
        "Wait on a pane. With run_id, wait for an earlier tmux_run to finish and return its output and exit code. With pattern, wait until a regular expression matches the last lines on screen, such as a server's ready line or an input prompt. Text already on screen counts.",
      inputSchema: {
        host,
        target,
        run_id: z.string().regex(/^[0-9a-f]+$/).optional().describe("run_id from tmux_run."),
        pattern: z.string().optional().describe("JavaScript regular expression, matched line by line."),
        lines: z.number().int().min(1).max(2000).optional().describe("With pattern: how many last lines to search. Default: 50."),
        timeout_s: timeout,
      },
      data: z.union([runSchema, z.looseObject({ matched: z.boolean(), match: z.string().nullable(), output: z.string(), pane: paneSchema })]),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async handler({ host: h, target: t, run_id, pattern, lines, timeout_s }) {
        if ((run_id === undefined) === (pattern === undefined)) {
          return fail({ code: "invalid_input", message: "Give exactly one of run_id and pattern." });
        }
        const seconds = timeout_s ?? 60;
        const pane = await paneInfo(exec, h, t);
        if (run_id) return ok(await waitRun(h, pane.pane_id, run_id, seconds), { host: h ?? "local" });
        let regex: RegExp;
        try {
          regex = new RegExp(pattern!);
        } catch (error) {
          return fail({ code: "invalid_input", message: `pattern is not a regular expression: ${(error as Error).message}` });
        }
        let last: string[] = [];
        let state: Pane = pane;
        const match = await poll(clock, seconds * 1000, async () => {
          last = await capture(exec, h, pane.pane_id, lines ?? 50);
          const hit = last.find((line) => regex.test(line));
          if (hit !== undefined) return hit;
          state = await paneInfo(exec, h, pane.pane_id);
          return state.dead ? null : undefined;
        });
        return ok({ matched: typeof match === "string", match: match ?? null, output: tail(last).output, pane: state }, { host: h ?? "local" });
      },
    }),

    defineTool({
      name: "tmux_read",
      description: "Read the last lines of a pane as plain text, with the pane's state. Use it to see a full-screen program or anything a person typed.",
      inputSchema: {
        host,
        target,
        lines: z.number().int().min(1).max(5000).optional().describe("How many last lines. Default: 100."),
      },
      data: z.looseObject({ text: z.string(), truncated: z.boolean(), pane: paneSchema }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async handler({ host: h, target: t, lines }) {
        const pane = await paneInfo(exec, h, t);
        const { output, truncated } = tail(await capture(exec, h, pane.pane_id, lines ?? 100));
        return ok({ text: output, truncated, pane }, { host: h ?? "local" });
      },
    }),

    defineTool({
      name: "tmux_send",
      description:
        'Type into a pane that runs an interactive program: text first, then tmux key names, then Enter. Use it to answer a prompt or press C-c. For a shell command use tmux_run, which also returns the output.',
      inputSchema: {
        host,
        target,
        text: z.string().optional().describe("Literal text, pasted as is."),
        keys: z.array(z.string().min(1)).optional().describe('tmux key names, such as ["C-c"], ["Up"], ["Escape", ":q", "Enter"].'),
        enter: z.boolean().optional().describe("Press Enter at the end. Default: false."),
      },
      data: z.looseObject({ sent: z.boolean(), target: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      async handler({ host: h, target: t, text, keys, enter }) {
        if (!text && !keys?.length && !enter) return fail({ code: "invalid_input", message: "Give text, keys or enter." });
        const pane = await paneInfo(exec, h, t);
        if (text) await pasteAndEnter(exec, h, pane.pane_id, text, false);
        const press = [...(keys ?? []), ...(enter ? ["Enter"] : [])];
        if (press.length) await tmux(exec, h, ["send-keys", "-t", pane.pane_id, ...press]);
        return ok({ sent: true, target: pane.pane_id }, { host: h ?? "local" });
      },
    }),

    defineTool({
      name: "tmux_kill",
      description: "End a tmux session and every program in it. Cannot be undone.",
      inputSchema: { host, session: z.string().min(1).describe("Exact session name.") },
      data: z.looseObject({ killed: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      async handler({ host: h, session }) {
        await tmux(exec, h, ["kill-session", "-t", `=${session}`]);
        return ok({ killed: session }, { host: h ?? "local" });
      },
    }),
  ];
  return tools;
}

