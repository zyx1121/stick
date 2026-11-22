import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxError } from "../tmux/exec.ts";
import { execOn } from "../host/exec.ts";
import type { Spawn } from "../host/os.ts";
import { SSH } from "../host/os.ts";

/** Where the installer puts the daemon on Windows. Kept from fw so existing installs keep working. */
export const DAEMON_ROOT = "C:\\dev\\fw";
const DAEMON_PORT = 9877;

/** A local port per host, away from the fw CLI's 19877, stable across restarts. */
export function localPort(host: string): number {
  let hash = 0;
  for (const ch of host) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return 29000 + (hash % 1000);
}

export interface DesktopReply {
  ok: boolean;
  reply: string;
  files: string[];
}

export class Desktop {
  private tokens = new Map<string, string>();
  private socketDir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "stick");

  constructor(private run: Spawn, private fetchFn: typeof fetch = fetch) {}

  private socket(host: string) {
    return join(this.socketDir, `${host}.desktop.sock`);
  }

  private async tunnel(host: string, fresh = false) {
    await mkdir(this.socketDir, { recursive: true });
    const sock = this.socket(host);
    if (fresh) await this.run(["ssh", "-S", sock, "-O", "exit", host], undefined, 5000);
    const check = await this.run(["ssh", "-S", sock, "-O", "check", host], undefined, 5000);
    if (check.code === 0) return;
    const port = localPort(host);
    const open = await this.run(
      [...SSH, "-fN", "-M", "-S", sock, "-o", "ControlPersist=30m", "-o", "ExitOnForwardFailure=yes", "-L", `${port}:127.0.0.1:${DAEMON_PORT}`, host],
      undefined,
      20000,
    );
    if (open.code !== 0) {
      throw new TmuxError({ code: "unreachable", message: `Could not open the desktop tunnel to ${host}.`, why: open.stderr.trim(), hint: `Check that \`ssh ${host}\` works.` });
    }
  }

  private async token(host: string, fresh = false): Promise<string> {
    if (!fresh && this.tokens.has(host)) return this.tokens.get(host)!;
    const read = await execOn(this.run, host, "windows", `[IO.File]::ReadAllText('${DAEMON_ROOT}\\token').Trim()`, undefined, 20000);
    const token = read.stdout.trim();
    if (read.code !== 0 || token.length < 16) {
      throw new TmuxError({ code: "desktop_missing", message: `The desktop daemon is not installed on ${host}.`, why: read.stderr.trim(), hint: "Call desktop_install for this host." });
    }
    this.tokens.set(host, token);
    return token;
  }

  private async post(host: string, script: string, force: boolean, token: string) {
    const headers: Record<string, string> = { "X-Fw-Token": token };
    if (force) headers["X-Fw-Force"] = "1";
    const res = await this.fetchFn(`http://127.0.0.1:${localPort(host)}/run`, { method: "POST", headers, body: script, signal: AbortSignal.timeout(300000) });
    return { status: res.status, text: await res.text() };
  }

  /** Send a script of desktop commands and download any screenshots or recordings it names. */
  async send(host: string, script: string, force: boolean): Promise<DesktopReply> {
    await this.tunnel(host);
    let token = await this.token(host);
    let answer: { status: number; text: string };
    try {
      answer = await this.post(host, script, force, token);
    } catch {
      // A tunnel that outlived a reboot of the host accepts the connection and then fails.
      await this.tunnel(host, true);
      try {
        answer = await this.post(host, script, force, token);
      } catch (error) {
        throw new TmuxError({ code: "desktop_down", message: `No answer from the desktop daemon on ${host}.`, why: String(error), hint: "Someone must be logged in at the desktop. Otherwise run desktop_install again." });
      }
    }
    if (answer.status === 401) {
      token = await this.token(host, true);
      answer = await this.post(host, script, force, token);
    }
    const files: string[] = [];
    const names = new Set(answer.text.match(/(shot|rec)-\d+-\d+\.(jpg|mp4)/g) ?? []);
    if (names.size && !/^\s*log\b/.test(script)) {
      const dir = join(tmpdir(), "stick", host);
      await mkdir(dir, { recursive: true });
      for (const name of names) {
        const res = await this.fetchFn(`http://127.0.0.1:${localPort(host)}/file?name=${name}`, { headers: { "X-Fw-Token": token } });
        if (!res.ok) continue;
        const path = join(dir, name);
        await Bun.write(path, await res.arrayBuffer());
        files.push(path);
      }
    }
    return { ok: answer.status === 200, reply: answer.text, files };
  }

  forget(host: string) {
    this.tokens.delete(host);
  }
}
