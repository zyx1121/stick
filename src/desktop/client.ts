import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { TmuxError } from "../tmux/exec.ts";
import { execOn } from "../host/exec.ts";
import type { Spawn } from "../host/os.ts";
import { SSH } from "../host/os.ts";

/** Where the installer puts the daemon on Windows. Kept from fw so existing installs keep working. */
export const DAEMON_ROOT = "C:\\dev\\fw";
const DAEMON_PORT = 9877;

/** Ask the kernel for a free local port. */
async function freePort(): Promise<number> {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

export interface DesktopReply {
  ok: boolean;
  reply: string;
  files: string[];
}

export class Desktop {
  private tokens = new Map<string, string>();
  private socketDir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "stick");
  private ports = new Map<string, number>();
  private lastOk = new Map<string, number>();

  constructor(private run: Spawn, private fetchFn: typeof fetch = fetch) {}

  private socket(host: string) {
    return join(this.socketDir, `${host}.desktop.sock`);
  }

  /**
   * One ssh master per host forwards a free local port to the daemon. The
   * listen side is pinned to 127.0.0.1 with GatewayPorts off, so a user's ssh
   * config cannot open it to the network, and a port someone else already
   * holds makes ssh fail instead of quietly binding another address. The port
   * is saved next to the socket, so a restarted server finds the live tunnel.
   */
  private async tunnel(host: string, fresh = false): Promise<number> {
    await mkdir(this.socketDir, { recursive: true, mode: 0o700 });
    const sock = this.socket(host);
    const portFile = `${sock}.port`;
    if (fresh) await this.run(["ssh", "-S", sock, "-O", "exit", host], undefined, 5000);
    const check = await this.run(["ssh", "-S", sock, "-O", "check", host], undefined, 5000);
    if (check.code === 0) {
      const saved = Number(await readFile(portFile, "utf8").catch(() => ""));
      if (saved > 0) {
        this.ports.set(host, saved);
        return saved;
      }
      await this.run(["ssh", "-S", sock, "-O", "exit", host], undefined, 5000);
    }
    const port = await freePort();
    const open = await this.run(
      [...SSH, "-fN", "-M", "-S", sock, "-o", "ControlPersist=30m", "-o", "ExitOnForwardFailure=yes", "-o", "GatewayPorts=no",
        "-L", `127.0.0.1:${port}:127.0.0.1:${DAEMON_PORT}`, host],
      undefined,
      20000,
    );
    if (open.code !== 0) {
      throw new TmuxError({ code: "unreachable", message: `Could not open the desktop tunnel to ${host}.`, why: open.stderr.trim(), hint: `Check that \`ssh ${host}\` works.` });
    }
    await writeFile(portFile, String(port), { mode: 0o600 });
    this.ports.set(host, port);
    return port;
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
    const port = this.ports.get(host);
    const headers: Record<string, string> = { "X-Fw-Token": token };
    if (force) headers["X-Fw-Force"] = "1";
    const res = await this.fetchFn(`http://127.0.0.1:${port}/run`, { method: "POST", headers, body: script, signal: AbortSignal.timeout(300000) });
    return { status: res.status, text: await res.text() };
  }

  /**
   * Send a script of desktop commands and download any screenshots or
   * recordings it names. A script is never sent twice: a click or a typed
   * form could run twice. When the tunnel has been idle, a read-only status
   * call checks it first, and a dead tunnel is rebuilt before the real script.
   */
  async send(host: string, script: string, force: boolean): Promise<DesktopReply> {
    await this.tunnel(host);
    let token = await this.token(host);
    if (Date.now() - (this.lastOk.get(host) ?? 0) > 60000) {
      let probe: { status: number; text: string };
      try {
        probe = await this.post(host, "status", false, token);
      } catch {
        // A tunnel that outlived a reboot of the host accepts the connection and then fails.
        await this.tunnel(host, true);
        try {
          probe = await this.post(host, "status", false, token);
        } catch (error) {
          throw new TmuxError({ code: "desktop_down", message: `No answer from the desktop daemon on ${host}.`, why: String(error), hint: "Someone must be logged in at the desktop. Otherwise run desktop_install again." });
        }
      }
      if (probe.status === 401) token = await this.token(host, true);
    }
    let answer: { status: number; text: string };
    try {
      answer = await this.post(host, script, force, token);
    } catch (error) {
      this.lastOk.delete(host);
      throw new TmuxError({
        code: "desktop_unknown",
        message: `The connection to ${host} dropped after the script was sent, so it may have run.`,
        why: String(error),
        hint: "Check the screen with snap or windows before you send it again.",
      });
    }
    // The daemon checks the token before it runs anything, so a 401 is safe to send again.
    if (answer.status === 401) {
      token = await this.token(host, true);
      answer = await this.post(host, script, force, token);
    }
    this.lastOk.set(host, Date.now());
    const files: string[] = [];
    const names = new Set(answer.text.match(/(shot|rec)-\d+-\d+\.(jpg|mp4)/g) ?? []);
    if (names.size && !/^\s*log\b/.test(script)) {
      // Under the user's cache with mode 0700, not a shared temp folder that other users can list.
      const dir = join(this.socketDir, "shots", host);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      for (const name of names) {
        const res = await this.fetchFn(`http://127.0.0.1:${this.ports.get(host)}/file?name=${name}`, { headers: { "X-Fw-Token": token } });
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
