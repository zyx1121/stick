import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, utimes, readdir, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sshHosts } from "../src/host/config.ts";
import { cleanStderr, execOn, killScript, plan, POSIX_RUNNER, posixQuote, powershellQuote, WINDOWS_COMMAND, windowsStdin } from "../src/host/exec.ts";
import { OsCache, spawn, type Spawn } from "../src/host/os.ts";
import { realClock } from "../src/tmux/pane.ts";
import { spawnExec } from "../src/tmux/exec.ts";
import { allTools } from "../src/tools/index.ts";

test("windows plan: fixed ASCII command line, script as base64 lines on stdin", () => {
  const script = `Get-Item "C:\\Users\\a b"; "中文 'q' \`"x\`""`;
  const cwd = "C:\\it's \u2019here\u2019; calc #";
  const { argv, stdin } = plan("win", "windows", script, cwd, "abc123");
  expect(argv.at(-1)).toBe(WINDOWS_COMMAND);
  expect(WINDOWS_COMMAND).toMatch(/^powershell -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  expect(WINDOWS_COMMAND.length).toBeLessThan(8000);
  const lines = stdin.trimEnd().split("\n");
  expect(lines[0]).toBe("abc123");
  expect(lines.at(-1)).toBe(".");
  expect(lines.slice(1, -1).every((line) => line.length <= 76)).toBe(true);
  const decoded = Buffer.from(lines.slice(1, -1).join(""), "base64").toString("utf8");
  const b64 = Buffer.from(cwd, "utf8").toString("base64");
  expect(decoded).toBe(`Set-Location -LiteralPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))) -ErrorAction Stop\n${script}`);
  expect(b64).toMatch(/^[A-Za-z0-9+/=]+$/);
  expect(windowsStdin("", "x1")).toBe("x1\n\n.\n");
});

test("windows timeout: a second call kills the recorded run by its id", async () => {
  const calls: { argv: string[]; stdin?: string }[] = [];
  const run = async (argv: string[], stdin?: string) => {
    calls.push({ argv, stdin });
    return { code: null, stdout: "", stderr: "", timedOut: calls.length === 1 } as never;
  };
  await execOn(run, "win", "windows", "Start-Sleep 99", undefined, 10);
  expect(calls).toHaveLength(2);
  const id = calls[0]!.stdin!.split("\n")[0]!;
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  const lines = calls[1]!.stdin!.trimEnd().split("\n").slice(1, -1);
  expect(Buffer.from(lines.join(""), "base64").toString("utf8")).toBe(killScript(id));
  expect(killScript(id)).toContain(`stick-${id}.pid`);
});

test("posix plan: the script goes on stdin to a runner that saves it first, cwd quoted", () => {
  const { argv, stdin } = plan("box", "posix", "echo hi", "/tmp/it's");
  expect(argv.slice(-2)).toEqual(["--", `sh -c ${posixQuote(POSIX_RUNNER)}`]);
  expect(stdin).toBe(`cd -- '/tmp/it'\\''s' || exit 1\necho hi\n`);
  expect(plan(undefined, "posix", "x").argv).toEqual(["sh", "-c", POSIX_RUNNER]);
});

test("posix runner saves scripts in a private 0700 folder and sweeps old files", async () => {
  const base = await mkdtemp(join(tmpdir(), "stick-runner-"));
  const dir = join(base, `stick-${process.getuid!()}`);
  try {
    await mkdir(dir, { mode: 0o755 });
    const past = new Date(Date.now() - 2 * 86400_000);
    await mkdir(join(dir, "cache"));
    for (const name of ["run.old", "run.abcdef", "settings.json", "cache/run.nested"]) {
      await writeFile(join(dir, name), "x");
      await utimes(join(dir, name), past, past);
    }
    const { argv, stdin } = plan(undefined, "posix", `echo $0; ls -ld ${posixQuote(dir)}`);
    const proc = Bun.spawn(argv, { stdin: new Blob([stdin]), stdout: "pipe", env: { ...process.env, TMPDIR: base } });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out).toContain(`${dir}/run.`);
    expect(out).toContain("drwx------");
    expect((await readdir(dir)).sort()).toEqual(["cache", "run.old", "settings.json"]);
    expect(await readdir(join(dir, "cache"))).toEqual(["run.nested"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("posix runner runs the script with the caller's umask", async () => {
  const base = await mkdtemp(join(tmpdir(), "stick-runner-"));
  try {
    const { stdin } = plan(undefined, "posix", "umask");
    const proc = Bun.spawn(["sh", "-c", `umask 0022; ${"sh -c " + posixQuote(POSIX_RUNNER)}`], { stdin: new Blob([stdin]), stdout: "pipe", env: { ...process.env, TMPDIR: base } });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out).toBe("stick:ran\n0022\n");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("posix runner refuses a symlinked folder", async () => {
  const base = await mkdtemp(join(tmpdir(), "stick-runner-"));
  try {
    await mkdir(join(base, "other"));
    await symlink(join(base, "other"), join(base, `stick-${process.getuid!()}`));
    const { argv, stdin } = plan(undefined, "posix", "echo hi");
    const proc = Bun.spawn(argv, { stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: base } });
    expect(await new Response(proc.stdout).text()).toBe("stick:ran\n");
    expect(await new Response(proc.stderr).text()).toBe(`stick: unsafe script folder ${join(base, `stick-${process.getuid!()}`)}\n`);
    expect(await proc.exited).toBe(125);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("posix runner refuses a regular file in place of the folder", async () => {
  const base = await mkdtemp(join(tmpdir(), "stick-runner-"));
  try {
    const path = join(base, `stick-${process.getuid!()}`);
    await writeFile(path, "x");
    const { argv, stdin } = plan(undefined, "posix", "echo hi");
    const proc = Bun.spawn(argv, { stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: base } });
    expect(await new Response(proc.stdout).text()).toBe("stick:ran\n");
    expect(await new Response(proc.stderr).text()).toEndWith(`stick: unsafe script folder ${path}\n`);
    expect(await proc.exited).toBe(125);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("exec reports an unsafe runner folder, not a bare exit 125", async () => {
  const mk = (stderr: string): Spawn => async (argv) =>
    argv.at(-1) === "uname -s" ? { code: 0, stdout: "Linux\n", stderr: "", timedOut: false } : { code: 125, stdout: "stick:ran\n", stderr, timedOut: false };
  const run = (spawnFn: Spawn) =>
    new Map(allTools({ exec: spawnExec("x"), clock: realClock, spawn: spawnFn, oses: new OsCache(spawnFn, "linux") }).map((t) => [t.name, t])).get("exec")!.run({ host: "box", command: "x" });
  const refused = await run(mk("stick: unsafe script folder /tmp/stick-1000\n"));
  expect(refused.structuredContent.error).toMatchObject({ code: "runner_dir_unsafe", message: "stick: unsafe script folder /tmp/stick-1000" });
  expect((await run(mk("own failure\n"))).structuredContent.data).toMatchObject({ exit_code: 125 });
});

test("powershellQuote doubles single quotes", () => {
  expect(powershellQuote("a'b")).toBe("'a''b'");
});

test("cleanStderr keeps the error text of CLIXML and drops progress records", () => {
  const raw = `#< CLIXML\n<Objs Version="1.1.0.1"><Obj S="progress"><AV>prep</AV></Obj><S S="Error">bad &amp; worse_x000D__x000A_</S></Objs>`;
  expect(cleanStderr(raw)).toBe("bad & worse\n");
  expect(cleanStderr("plain")).toBe("plain");
});

test("OsCache asks once per host and reads cmd's %OS%", async () => {
  const calls: string[] = [];
  const fake: Spawn = async (argv) => {
    calls.push(argv.at(-1)!);
    const host = argv.at(-3);
    if (argv.at(-1) === "echo %OS%") return { code: 0, stdout: host === "win" ? "Windows_NT\r\n" : "%OS%\n", stderr: "", timedOut: false };
    return { code: host === "pwsh" ? 1 : 0, stdout: host === "pwsh" ? "" : "Linux\n", stderr: "", timedOut: false };
  };
  const oses = new OsCache(fake, "darwin");
  expect(await oses.of("win")).toBe("windows");
  expect(await oses.of("win")).toBe("windows");
  expect(await oses.of("box")).toBe("posix");
  expect(await oses.of("pwsh")).toBe("windows");
  expect(await oses.of(undefined)).toBe("posix");
  expect(calls.filter((c) => c === "echo %OS%")).toHaveLength(3);
  const down: Spawn = async () => ({ code: 255, stdout: "", stderr: "Connection refused", timedOut: false });
  await expect(new OsCache(down).of("gone")).rejects.toMatchObject({ error: { code: "unreachable" } });
});

test("sshHosts reads Host lines, follows Include and skips patterns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stick-ssh-"));
  try {
    await mkdir(join(dir, "more"));
    await writeFile(join(dir, "more", "a.conf"), "Host inner1 inner2\n  HostName x\n");
    await writeFile(join(dir, "config"), `Include ${dir}/more/*.conf\nHost box\nHost *.lab !skip\nHost box\n`);
    expect((await sshHosts(join(dir, "config"))).sort()).toEqual(["box", "inner1", "inner2"]);
    expect(await sshHosts(join(dir, "missing"))).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const tools = new Map(allTools({ exec: spawnExec(`stick-host-${process.pid}`), clock: realClock, spawn, oses: new OsCache(spawn, "linux") }).map((t) => [t.name, t]));
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await tools.get(name)!.run(args);
  return { data: r.structuredContent.data as any, error: r.structuredContent.error as any };
};

test("exec runs a local bash script: quoting, stderr, exit code, cwd and timeout", async () => {
  const run = await call("exec", { command: `echo 'a "b"' \\$HOME 中文; echo oops >&2\nexit 3`, cwd: "/tmp" });
  expect(run.data).toMatchObject({ os: "posix", exit_code: 3, stdout: `a "b" $HOME 中文\n`, stderr: "oops\n", timed_out: false });
  expect((await call("exec", { command: "pwd", cwd: "/tmp" })).data.stdout).toMatch(/tmp\n$/);
  expect((await call("exec", { command: "true", cwd: "/no/such/dir" })).data.exit_code).toBe(1);
  // A command that reads stdin must not eat the lines after it.
  expect((await call("exec", { command: "cat >/dev/null\nread x; echo got=$x\necho SECOND" })).data).toMatchObject({ exit_code: 0, stdout: "got=\nSECOND\n" });
  expect((await call("exec", { command: "exit 255" })).data.exit_code).toBe(255);
  const slow = await call("exec", { command: "sleep 5", timeout_s: 1 });
  expect(slow.data).toMatchObject({ timed_out: true, exit_code: null });
});

test("exec timeout leaves a 0700 folder and the next call sweeps a file two days old", async () => {
  const base = await mkdtemp(join(tmpdir(), "stick-sweep-"));
  const dir = join(base, `stick-${process.getuid!()}`);
  const inBase: Spawn = (argv, stdin, timeoutMs) => spawn(["env", `TMPDIR=${base}`, ...argv], stdin, timeoutMs);
  try {
    const slow = await execOn(inBase, undefined, "posix", "sleep 30", undefined, 1000);
    expect(slow.timedOut).toBe(true);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    const old = join(dir, "run.abcdef");
    await writeFile(old, "x");
    const past = new Date(Date.now() - 2 * 86400_000);
    await utimes(old, past, past);
    expect(await execOn(inBase, undefined, "posix", "true", undefined, 10000)).toMatchObject({ code: 0 });
    expect(await readdir(dir)).not.toContain("run.abcdef");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("exec tells a script that exits 255 from an ssh failure by the runner marker", async () => {
  // The OS probes succeed; only the exec call itself comes back with 255.
  const mk = (stdout: string, stderr: string): Spawn => async (argv) =>
    argv.at(-1) === "echo %OS%" || argv.at(-1) === "uname -s"
      ? { code: 0, stdout: argv.at(-1) === "uname -s" ? "Linux\n" : "%OS%\n", stderr: "", timedOut: false }
      : { code: 255, stdout, stderr, timedOut: false };
  const run = (spawnFn: Spawn) =>
    new Map(allTools({ exec: spawnExec("x"), clock: realClock, spawn: spawnFn, oses: new OsCache(spawnFn, "linux") }).map((t) => [t.name, t])).get("exec")!.run({ host: "box", command: "x" });
  const ranScript = await run(mk("stick:ran\nout\n", "ssh: connect to host inner port 22: Connection refused\n"));
  expect(ranScript.structuredContent.data).toMatchObject({ exit_code: 255, stdout: "out\n" });
  const sshDown = await run(mk("", "ssh: connect to host box port 22: Connection refused\n"));
  expect(sshDown.structuredContent.error).toMatchObject({ code: "unreachable" });
});

test("desktop refuses a host that is not Windows", async () => {
  const oses = new OsCache(async () => ({ code: 0, stdout: "%OS%\n", stderr: "", timedOut: false }));
  const t = new Map(allTools({ exec: spawnExec("x"), clock: realClock, oses }).map((x) => [x.name, x]));
  const r = await t.get("desktop")!.run({ host: "box", script: "windows" });
  expect(r.structuredContent.error).toMatchObject({ code: "unsupported_os" });
});
