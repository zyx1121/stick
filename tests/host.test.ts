import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localPort } from "../src/desktop/client.ts";
import { sshHosts } from "../src/host/config.ts";
import { cleanStderr, plan, powershellQuote, WINDOWS_COMMAND, windowsStdin } from "../src/host/exec.ts";
import { OsCache, spawn, type Spawn } from "../src/host/os.ts";
import { realClock } from "../src/tmux/pane.ts";
import { spawnExec } from "../src/tmux/exec.ts";
import { allTools } from "../src/tools/index.ts";

test("windows plan: fixed ASCII command line, script as base64 lines on stdin", () => {
  const script = `Get-Item "C:\\Users\\a b"; "中文 'q' \`"x\`""`;
  const { argv, stdin } = plan("win", "windows", script, "C:\\it's here");
  expect(argv.at(-1)).toBe(WINDOWS_COMMAND);
  expect(WINDOWS_COMMAND).toMatch(/^powershell -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  expect(WINDOWS_COMMAND.length).toBeLessThan(8000);
  const lines = stdin.trimEnd().split("\n");
  expect(lines.at(-1)).toBe(".");
  expect(lines.slice(0, -1).every((line) => line.length <= 76)).toBe(true);
  const decoded = Buffer.from(lines.slice(0, -1).join(""), "base64").toString("utf8");
  expect(decoded).toBe(`Set-Location -LiteralPath 'C:\\it''s here' -ErrorAction Stop\n${script}`);
  expect(windowsStdin("")).toBe("\n.\n");
});

test("posix plan: the script goes to bash -s on stdin, cwd quoted", () => {
  const { argv, stdin } = plan("box", "posix", "echo hi", "/tmp/it's");
  expect(argv.slice(-2)).toEqual(["--", `sh -c 'command -v bash >/dev/null 2>&1 && exec bash -s || exec sh -s'`]);
  expect(stdin).toBe(`cd -- '/tmp/it'\\''s' || exit 1\necho hi\n`);
  expect(plan(undefined, "posix", "x").argv).toEqual(["bash", "-s"]);
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

test("localPort is stable and out of the fw CLI's way", () => {
  expect(localPort("furnace")).toBe(localPort("furnace"));
  expect(localPort("furnace")).toBeGreaterThanOrEqual(29000);
  expect(localPort("furnace")).toBeLessThan(30000);
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
  const slow = await call("exec", { command: "sleep 5", timeout_s: 1 });
  expect(slow.data).toMatchObject({ timed_out: true, exit_code: null });
});

test("desktop refuses a host that is not Windows", async () => {
  const oses = new OsCache(async () => ({ code: 0, stdout: "%OS%\n", stderr: "", timedOut: false }));
  const t = new Map(allTools({ exec: spawnExec("x"), clock: realClock, oses }).map((x) => [x.name, x]));
  const r = await t.get("desktop")!.run({ host: "box", script: "windows" });
  expect(r.structuredContent.error).toMatchObject({ code: "unsupported_os" });
});
