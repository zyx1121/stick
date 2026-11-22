import { z } from "zod";
import { fail, ok } from "../core/result.ts";
import { defineTool, type ToolboxTool } from "../core/tool.ts";
import { DAEMON_ROOT, type Desktop } from "../desktop/client.ts";
import { execOn, powershellQuote } from "../host/exec.ts";
import type { OsCache, Spawn } from "../host/os.ts";
import { HOST_PATTERN } from "../tmux/exec.ts";
import daemonSource from "../../windows/fwd.cs" with { type: "text" };
import installer from "../../windows/install.ps1" with { type: "text" };
import lock from "../../windows/lock.ps1" with { type: "text" };

const windowsHost = z.string().regex(HOST_PATTERN, "A host is an SSH alias, user@host or address.").describe("SSH host of a Windows machine. Log in as the user who sits at its desktop.");

const COMMANDS = `Commands, one per line:
  windows                       what is open
  snap <window>                 the interface of one window as text; each element gets a ref such as e12
  invoke <ref> | click <target> | dblclick <target> | rclick <target>
  type <text> | paste <text> | key <keys>   (key ctrl+s, key alt+f4)
  set <ref> <text>              set the value of an edit field
  focus <window> | exec <program> | waitfor <window> <seconds>
  shot [window <name>] [--grid <px>] [--diff]   small JPEG; the result lists its local path
  rec start | rec stop          record the desktop to mp4
  status | log | help
A target is a ref (e12), a pixel of the last shot (@640,360) or a screen pixel (640,360).`;

export function desktopTools(run: Spawn, oses: OsCache, desktop: Desktop): ToolboxTool[] {
  async function requireWindows(host: string) {
    if ((await oses.of(host)) !== "windows") {
      return fail({ code: "unsupported_os", message: `${host} is not Windows.`, hint: "desktop drives a Windows desktop only." });
    }
    return undefined;
  }

  return [
    defineTool({
      name: "desktop",
      description: `Use the desktop of a Windows host: read windows as text, click, type and take small screenshots. Read with snap before you look with shot. A script runs in order and stops at the first error. Screenshots are saved on this machine; read them by the paths in files.\n${COMMANDS}`,
      inputSchema: {
        host: windowsHost,
        script: z.string().min(1).describe("One command per line."),
        force: z.boolean().optional().describe("Send cursor and keyboard commands even while a person is using the machine. Default: false."),
      },
      data: z.looseObject({ ok: z.boolean(), reply: z.string(), files: z.array(z.string()).describe("Local paths of screenshots and recordings.") }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      async handler({ host, script, force }) {
        const wrong = await requireWindows(host);
        if (wrong) return wrong;
        const result = await desktop.send(host, script, force ?? false);
        return ok(result, { host });
      },
    }),

    defineTool({
      name: "desktop_install",
      description:
        "Install or update the desktop daemon on a Windows host: copy its source, build it with the C# compiler that ships with Windows, and start it at every logon of the ssh user. The user must be an administrator and logged in at the desktop. It replaces a running daemon and issues a new token. Its folder is readable by SYSTEM and Administrators only.",
      inputSchema: { host: windowsHost },
      data: z.looseObject({ output: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      async handler({ host }) {
        const wrong = await requireWindows(host);
        if (wrong) return wrong;
        const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
        const script = [
          // Lock the folder before any file lands in it; install.ps1 runs the same lock again.
          `$ErrorActionPreference = 'Stop'`,
          lock,
          `$src = Join-Path ${powershellQuote(DAEMON_ROOT)} 'src'`,
          `New-Item -ItemType Directory -Force -Path $src | Out-Null`,
          `[IO.File]::WriteAllBytes((Join-Path $src 'fwd.cs'), [Convert]::FromBase64String('${b64(daemonSource)}'))`,
          `[IO.File]::WriteAllBytes((Join-Path $src 'install.ps1'), [Convert]::FromBase64String('${b64(installer)}'))`,
          `[IO.File]::WriteAllBytes((Join-Path $src 'lock.ps1'), [Convert]::FromBase64String('${b64(lock)}'))`,
          `powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $src 'install.ps1')`,
          `if ($LASTEXITCODE) { exit $LASTEXITCODE }`,
        ].join("\n");
        const result = await execOn(run, host, "windows", script, undefined, 300000);
        desktop.forget(host);
        if (result.code !== 0) {
          return fail({ code: "upstream_error", message: `The installer failed on ${host} (exit ${result.code}).`, why: (result.stderr || result.stdout).trim().slice(-2000) });
        }
        return ok({ output: result.stdout.trim() }, { host });
      },
    }),
  ];
}
