import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sshHosts } from "../src/host/config.ts";
import { cleanStderr, plan, POSIX_RUNNER, posixQuote, powershellQuote, WINDOWS_COMMAND, windowsStdin } from "../src/host/exec.ts";
import { OsCache, spawn, type Spawn } from "../src/host/os.ts";
import { realClock } from "../src/tmux/pane.ts";
import { spawnExec } from "../src/tmux/exec.ts";
import { allTools } from "../src/tools/index.ts";

test("windows plan: fixed ASCII command line, script as base64 lines on stdin", () => {
  const script = `Get-Item "C:\\Users\\a b"; "中文 'q' \`"x\`""`;
  const cwd = "C:\\it's \u2019here\u2019; calc #";
  const { argv, stdin } = plan("win", "windows", script, cwd);
  expect(argv.at(-1)).toBe(WINDOWS_COMMAND);
  expect(WINDOWS_COMMAND).toMatch(/^powershell -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  expect(WINDOWS_COMMAND.length).toBeLessThan(8000);
  const lines = stdin.trimEnd().split("\n");
  expect(lines.at(-1)).toBe(".");
  expect(lines.slice(0, -1).every((line) => line.length <= 76)).toBe(true);
  const decoded = Buffer.from(lines.slice(0, -1).join(""), "base64").toString("utf8");
  const b64 = Buffer.from(cwd, "utf8").toString("base64");
  expect(decoded).toBe(`Set-Location -LiteralPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))) -ErrorAction Stop\n${script}`);
  expect(b64).toMatch(/^[A-Za-z0-9+/=]+$/);
  expect(windowsStdin("")).toBe("\n.\n");
});

test("posix plan: the script goes on stdin to a runner that saves it first, cwd quoted", () => {
  const { argv, stdin } = plan("box", "posix", "echo hi", "/tmp/it's");
  expect(argv.slice(-2)).toEqual(["--", `sh -c ${posixQuote(POSIX_RUNNER)}`]);
  expect(stdin).toBe(`cd -- '/tmp/it'\\''s' || exit 1\necho hi\n`);
  expect(plan(undefined, "posix", "x").argv).toEqual(["sh", "-c", POSIX_RUNNER]);
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

test("desktop refuses a host that is not Windows", async () => {
  const oses = new OsCache(async () => ({ code: 0, stdout: "%OS%\n", stderr: "", timedOut: false }));
  const t = new Map(allTools({ exec: spawnExec("x"), clock: realClock, oses }).map((x) => [x.name, x]));
  const r = await t.get("desktop")!.run({ host: "box", script: "windows" });
  expect(r.structuredContent.error).toMatchObject({ code: "unsupported_os" });
});
