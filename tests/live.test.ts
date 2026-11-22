import { afterAll, expect, test } from "bun:test";
import { spawnExec } from "../src/tmux/exec.ts";
import { realClock } from "../src/tmux/pane.ts";
import { allTools } from "../src/tools/index.ts";
import { OsCache } from "../src/host/os.ts";

// A private tmux server on its own socket, so the tests never touch a real session.
const socket = `tmux-mcp-test-${process.pid}`;
const exec = spawnExec(socket);
const tools = new Map(allTools({ exec, clock: realClock, oses: new OsCache(undefined, "linux") }).map((tool) => [tool.name, tool]));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await tools.get(name)!.run(args);
  return { isError: result.isError, data: result.structuredContent.data as any, error: result.structuredContent.error as any };
};

afterAll(async () => {
  await exec(undefined, ["kill-server"]);
});

test("an empty server lists no panes", async () => {
  expect((await call("tmux_list")).data.panes).toEqual([]);
});

test("new, run, wait, send, read, list and kill against a real tmux", async () => {
  const created = await call("tmux_new", { session: "t1", cwd: "/tmp" });
  expect(created.isError).toBe(false);
  const pane = created.data.pane.pane_id as string;
  expect(created.data.pane.command).toMatch(/^-?(ba|z|da)?sh$/);

  const echo = await call("tmux_run", { target: "t1", command: "echo hi; echo there" });
  expect(echo.data).toMatchObject({ done: true, exit_code: 0, output: "hi\nthere" });

  const failed = await call("tmux_run", { target: pane, command: "printf abc; exit_code_is() { return 3; }; exit_code_is" });
  expect(failed.data).toMatchObject({ done: true, exit_code: 3, output: "abc" });

  const multi = await call("tmux_run", { target: pane, command: "for i in 1 2 3; do\n  echo \"n=$i\"\ndone\nfalse" });
  expect(multi.data).toMatchObject({ exit_code: 1, output: "n=1\nn=2\nn=3" });

  const quoted = await call("tmux_run", { target: pane, command: `echo 'single' "double" {a,b} $((1+2)) '#{x}'` });
  expect(quoted.data.output).toBe("single double a b 3 #{x}");

  const slow = await call("tmux_run", { target: pane, command: "sleep 4; echo late", timeout_s: 1 });
  expect(slow.data).toMatchObject({ done: false, exit_code: null });
  expect((await call("tmux_run", { target: pane, command: "echo no" })).error).toMatchObject({ code: "busy" });
  const waited = await call("tmux_wait", { target: pane, run_id: slow.data.run_id, timeout_s: 10 });
  expect(waited.data).toMatchObject({ done: true, exit_code: 0, output: "late" });

  await call("tmux_send", { target: pane, text: "sleep 30", enter: true });
  let running = "";
  for (let i = 0; i < 50 && running !== "sleep"; i++) {
    await Bun.sleep(100);
    running = (await call("tmux_list")).data.panes[0].command;
  }
  expect(running).toBe("sleep");
  expect((await call("tmux_run", { target: pane, command: "echo no" })).error).toMatchObject({ code: "busy" });
  await call("tmux_send", { target: pane, keys: ["C-c"] });
  const back = await call("tmux_run", { target: pane, command: "echo back", timeout_s: 10 });
  expect(back.data).toMatchObject({ done: true, output: "back" });

  const ready = await call("tmux_wait", { target: pane, pattern: "^back$", timeout_s: 2 });
  expect(ready.data).toMatchObject({ matched: true, match: "back" });
  const never = await call("tmux_wait", { target: pane, pattern: "^nope$", timeout_s: 1 });
  expect(never.data.matched).toBe(false);

  const read = (await call("tmux_read", { target: pane, lines: 3 })).data.text as string;
  expect(read.split("\n")).toHaveLength(3);
  expect(created.data.pane).toMatchObject({ path: expect.stringMatching(/tmp$/) });
  expect((await call("tmux_new", { session: "t1" })).error).toMatchObject({ code: "exists" });
  expect((await call("tmux_kill", { session: "t1" })).data).toEqual({ killed: "t1" });
  expect((await call("tmux_read", { target: "t1" })).error).toMatchObject({ code: "not_found" });
}, 60000);

test("bad input comes back as invalid_input", async () => {
  expect((await call("tmux_list", { host: "-oProxyCommand=x" })).error).toMatchObject({ code: "invalid_input" });
  expect((await call("tmux_wait", { target: "x" })).error).toMatchObject({ code: "invalid_input" });
  expect((await call("tmux_send", { target: "x" })).error).toMatchObject({ code: "invalid_input" });
});
