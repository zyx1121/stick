import { z } from "zod";
import { fail, ok } from "../core/result.ts";
import { defineTool, type ToolboxTool } from "../core/tool.ts";
import { sshHosts } from "../host/config.ts";
import { execOn } from "../host/exec.ts";
import type { OsCache, Spawn } from "../host/os.ts";
import { classify, HOST_PATTERN, TmuxError } from "../tmux/exec.ts";

const MAX_CHARS = 20000;
const keepEnd = (text: string) => (text.length <= MAX_CHARS ? text : text.slice(-MAX_CHARS));

export const hostInput = z
  .string()
  .regex(HOST_PATTERN, "A host is an SSH alias, user@host or address.")
  .optional()
  .describe("SSH host as in ~/.ssh/config, or user@host. Omit for this machine.");

export function hostTools(run: Spawn, oses: OsCache, configPath?: string): ToolboxTool[] {
  return [
    defineTool({
      name: "hosts",
      description:
        "List the hosts in ~/.ssh/config with their OS where known. With host, connect once and report its OS: posix means write bash for exec, windows means write PowerShell.",
      inputSchema: { host: hostInput },
      data: z.looseObject({
        hosts: z.array(z.looseObject({ name: z.string(), os: z.string().nullable().describe("posix, windows, or null when not probed yet.") })),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async handler({ host }) {
        if (host) return ok({ hosts: [{ name: host, os: await oses.of(host) }] });
        const names = await sshHosts(configPath);
        return ok({ hosts: names.map((name) => ({ name, os: oses.peek(name) ?? null })) });
      },
    }),

    defineTool({
      name: "exec",
      description:
        "Run a command on a host and return stdout, stderr and the exit code. Same call for every OS: write bash for a posix host and PowerShell for a windows host (the result's os says which). The command travels on stdin, so quotes, backslashes, semicolons and non-ASCII text arrive unchanged, and output comes back as UTF-8. For work that outlives the timeout, use tmux_run.",
      inputSchema: {
        host: hostInput,
        command: z.string().min(1).describe("A bash script for posix hosts, a PowerShell script for windows hosts. Several lines are fine."),
        cwd: z.string().optional().describe("Directory to run in."),
        timeout_s: z.number().int().min(1).max(600).optional().describe("Seconds before the local ssh is stopped. Default: 120."),
      },
      data: z.looseObject({
        os: z.string(),
        exit_code: z.number().nullable(),
        stdout: z.string(),
        stderr: z.string(),
        timed_out: z.boolean().describe("True when the timeout stopped the call. On Windows the remote program may still run."),
        elapsed_ms: z.number(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      async handler({ host, command, cwd, timeout_s }) {
        const os = await oses.of(host);
        const result = await execOn(run, host, os, command, cwd, (timeout_s ?? 120) * 1000);
        if (host && result.code === 255 && !result.timedOut) return fail(classify(host, result));
        return ok(
          {
            os,
            exit_code: result.timedOut ? null : result.code,
            stdout: keepEnd(result.stdout),
            stderr: keepEnd(result.stderr),
            timed_out: result.timedOut,
            elapsed_ms: result.elapsedMs,
          },
          { host: host ?? "local" },
        );
      },
    }),
  ];
}

/** tmux tools drive POSIX hosts only. */
export async function requirePosix(oses: OsCache, host: string | undefined) {
  if ((await oses.of(host)) === "windows") {
    throw new TmuxError({
      code: "unsupported_os",
      message: `${host ?? "This machine"} runs Windows, which has no tmux.`,
      hint: "Use exec for commands, or add an ssh host that lands inside WSL and use tmux there.",
    });
  }
}
