import { classify, TmuxError, type ExecResult } from "../tmux/exec.ts";

export type Os = "posix" | "windows";

/** Runs one command line on a host through ssh, or locally when host is undefined. */
export type Spawn = (argv: string[], stdin?: string, timeoutMs?: number) => Promise<ExecResult & { timedOut: boolean }>;

function collect(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  const done = (async () => {
    for await (const chunk of stream) chunks.push(chunk);
  })().catch(() => {});
  return { done, text: () => Buffer.concat(chunks).toString("utf8") };
}

export const spawn: Spawn = async (argv, stdin, timeoutMs) => {
  const proc = Bun.spawn(argv, {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = timeoutMs ? setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs) : undefined;
  const out = collect(proc.stdout);
  const err = collect(proc.stderr);
  const code = await proc.exited;
  if (timer) clearTimeout(timer);
  // A child left in the background can hold the pipes open after the shell exits. Wait 1 s at most.
  await Promise.race([Promise.all([out.done, err.done]), Bun.sleep(1000)]);
  return { code, stdout: out.text(), stderr: err.text(), timedOut };
};

export const SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

/** Detect a host's OS once and remember it for the life of the server. */
export class OsCache {
  private known = new Map<string, Os>();

  constructor(private run: Spawn = spawn, private platform: string = process.platform) {}

  async of(host: string | undefined): Promise<Os> {
    if (!host) return this.platform === "win32" ? "windows" : "posix";
    const cached = this.known.get(host);
    if (cached) return cached;
    // cmd expands %OS% to Windows_NT; a POSIX shell prints it as is.
    const probe = await this.run([...SSH, host, "--", "echo %OS%"], undefined, 20000);
    if (probe.code === 255) throw new TmuxError(classify(host, probe));
    let os: Os;
    if (probe.stdout.trim() === "Windows_NT") os = "windows";
    else {
      const uname = await this.run([...SSH, host, "--", "uname -s"], undefined, 20000);
      // A dropped connection says nothing about the OS: do not remember a guess.
      if (uname.code === 255 || uname.timedOut) throw new TmuxError(classify(host, { ...uname, code: 255 }));
      os = uname.code === 0 && uname.stdout.trim() ? "posix" : "windows";
    }
    this.known.set(host, os);
    return os;
  }

  peek(host: string): Os | undefined {
    return this.known.get(host);
  }
}
