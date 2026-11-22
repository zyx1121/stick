import { expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("the installed bundle loads without source or node_modules and answers", async () => {
  const temp = await mkdtemp(join(tmpdir(), "tmux plugin "));
  const client = new Client({ name: "tmux-test", version: "1" });
  try {
    await cp(new URL("../dist", import.meta.url), join(temp, "dist"), { recursive: true });
    const env = { ...process.env, TMUX_MCP_SOCKET: `tmux-mcp-bundle-${process.pid}` } as Record<string, string>;
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(temp, "dist/server.js")], cwd: temp, env, stderr: "pipe" }));

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "tmux_kill", "tmux_list", "tmux_new", "tmux_read", "tmux_run", "tmux_send", "tmux_wait",
    ]);
    const panes = await client.callTool({ name: "tmux_list", arguments: {} });
    expect(panes.isError).toBe(false);
    expect(panes.structuredContent).toMatchObject({ data: { panes: [] } });
  } finally {
    await client.close();
    await rm(temp, { recursive: true, force: true });
  }
}, 60000);
