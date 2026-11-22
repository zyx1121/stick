import type { ToolboxTool } from "../core/tool.ts";
import { Desktop } from "../desktop/client.ts";
import { OsCache, spawn as realSpawn, type Spawn } from "../host/os.ts";
import type { Exec } from "../tmux/exec.ts";
import type { Clock } from "../tmux/pane.ts";
import { desktopTools } from "./desktop.ts";
import { hostTools } from "./host.ts";
import { tmuxTools } from "./tmux.ts";

export interface Deps {
  exec: Exec;
  clock: Clock;
  spawn?: Spawn;
  oses?: OsCache;
  sshConfig?: string;
}

export function allTools({ exec, clock, spawn = realSpawn, oses = new OsCache(spawn), sshConfig }: Deps): ToolboxTool[] {
  return [...hostTools(spawn, oses, sshConfig), ...tmuxTools(exec, clock, oses), ...desktopTools(spawn, oses, new Desktop(spawn))];
}
