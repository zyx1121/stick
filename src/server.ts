import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./core/tool.ts";
import { spawnExec } from "./tmux/exec.ts";
import { realClock } from "./tmux/pane.ts";
import { allTools } from "./tools/index.ts";
import manifest from "../plugin.json";

const server = new McpServer({ name: manifest.name, version: manifest.version });
const tools = allTools(spawnExec(process.env.TMUX_MCP_SOCKET || undefined), realClock);
registerTools(server, tools);
console.error(`[tmux-mcp] registered ${tools.length}`);
await server.connect(new StdioServerTransport());
