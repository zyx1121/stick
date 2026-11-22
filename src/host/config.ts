import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Host aliases from an ssh config and the files it includes. Patterns with wildcards are not hosts. */
export async function sshHosts(path = join(homedir(), ".ssh", "config"), seen = new Set<string>()): Promise<string[]> {
  if (seen.has(path)) return [];
  seen.add(path);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const hosts: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const include = /^include\s+(.+)$/i.exec(line);
    if (include) {
      for (const pattern of include[1]!.split(/\s+/)) {
        const full = pattern.replace(/^~/, homedir());
        const abs = full.startsWith("/") ? full : join(homedir(), ".ssh", full);
        const glob = new Bun.Glob(abs.slice(1));
        for await (const file of glob.scan({ cwd: "/", absolute: true })) hosts.push(...(await sshHosts(file, seen)));
      }
      continue;
    }
    const host = /^host\s+(.+)$/i.exec(line);
    if (host) hosts.push(...host[1]!.split(/\s+/).filter((name) => !/[*?!]/.test(name)));
  }
  return [...new Set(hosts)];
}
