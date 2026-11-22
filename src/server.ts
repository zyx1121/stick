import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./core/tool.ts";
import { spawnExec } from "./tmux/exec.ts";
import { realClock } from "./tmux/pane.ts";
import { allTools } from "./tools/index.ts";
import manifest from "../plugin.json";

const server = new McpServer({ name: manifest.name, version: manifest.version });
const tools = allTools({ exec: spawnExec(process.env.STICK_TMUX_SOCKET || undefined), clock: realClock });
registerTools(server, tools);
console.error(`[stick] registered ${tools.length}`);
await server.connect(new StdioServerTransport());
