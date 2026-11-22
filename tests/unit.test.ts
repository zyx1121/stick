import { expect, test } from "bun:test";
import { classify, commandFor, HOST_PATTERN, shellQuote } from "../src/tmux/exec.ts";
import { extractRun, isShell, poll, wrapCommand, type Clock } from "../src/tmux/pane.ts";

test("shellQuote leaves plain words and quotes the rest", () => {
  expect(shellQuote("list-panes")).toBe("list-panes");
  expect(shellQuote("#{pane_id}")).toBe("'#{pane_id}'");
  expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  expect(shellQuote(";")).toBe("';'");
});

test("commandFor runs tmux directly or through ssh with one quoted string", () => {
  expect(commandFor(undefined, ["ls"], "t")).toEqual(["tmux", "-L", "t", "ls"]);
  const remote = commandFor("sandbox", ["send-keys", "-t", "a", "it's"]);
  expect(remote.slice(0, 6)).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "sandbox"]);
  expect(remote.at(-1)).toBe(`tmux send-keys -t a 'it'\\''s'`);
});

test("hosts cannot start with a dash", () => {
  expect(HOST_PATTERN.test("loki@sandbox")).toBe(true);
  expect(HOST_PATTERN.test("10.0.0.1")).toBe(true);
  expect(HOST_PATTERN.test("-oProxyCommand=x")).toBe(false);
  expect(HOST_PATTERN.test("a b")).toBe(false);
});

test("classify maps ssh and tmux failures to codes", () => {
  expect(classify("h", { code: 255, stdout: "", stderr: "Connection refused" }).code).toBe("unreachable");
  expect(classify("h", { code: 127, stdout: "", stderr: "bash: line 1: tmux: command not found" }).code).toBe("tmux_missing");
  expect(classify(undefined, { code: 1, stdout: "", stderr: "can't find session: x" }).code).toBe("not_found");
  expect(classify(undefined, { code: 1, stdout: "", stderr: "duplicate session: x" }).code).toBe("exists");
  expect(classify(undefined, { code: 1, stdout: "", stderr: "weird" }).code).toBe("upstream_error");
});

test("extractRun ignores the echoed command and reads between the markers", () => {
  const typed = wrapCommand("ab12", "echo hi").split("\n");
  const rows = ["$" + typed[0], "> " + typed[1], "KILO_ab12_START", "hi", "", "KILO_ab12_END 0", "$"];
  expect(extractRun("ab12", rows)).toEqual({ exit_code: 0, started: true, lines: ["hi"] });
  expect(extractRun("ab12", rows.slice(0, 4))).toEqual({ exit_code: null, started: true, lines: ["hi"] });
  expect(extractRun("ab12", ["KILO_ab12_START", "abc", "KILO_ab12_END 3"])).toEqual({ exit_code: 3, started: true, lines: ["abc"] });
  expect(extractRun("ab12", ["KILO_ab12_START", "", "KILO_ab12_END 0"]).lines).toEqual([]);
});

test("isShell accepts login shells and rejects programs", () => {
  expect(isShell("-zsh")).toBe(true);
  expect(isShell("bash")).toBe(true);
  expect(isShell("vim")).toBe(false);
  expect(isShell("fish")).toBe(false);
});

test("poll backs off and gives up at the deadline", async () => {
  let now = 0;
  const waits: number[] = [];
  const clock: Clock = { now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } };
  expect(await poll(clock, 1000, async () => undefined)).toBeUndefined();
  expect(waits.slice(0, 4)).toEqual([50, 100, 200, 400]);
  expect(now).toBe(1000);
  expect(await poll(clock, 1000, async () => 7)).toBe(7);
});
