import { SSH, type Os, type Spawn } from "./os.ts";

/**
 * Fixed PowerShell wrapper. It is sent as -EncodedCommand, so no shell between
 * here and powershell.exe parses it. It switches every stream to UTF-8 first,
 * then reads the real script from stdin as base64 lines up to a line holding
 * ".", so the script never meets cmd's quoting or its 8191 character limit.
 * Windows OpenSSH does not pass end of input to the program, hence the sentinel.
 */
const WINDOWS_WRAPPER = [
  `$ErrorActionPreference="Continue";$ProgressPreference="SilentlyContinue";$env:WSL_UTF8="1"`,
  `$u=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=$u;$OutputEncoding=$u`,
  `$b=[Text.StringBuilder]::new();while(($l=[Console]::In.ReadLine()) -ne $null -and $l -ne "."){[void]$b.Append($l)}`,
  `$src=$u.GetString([Convert]::FromBase64String($b.ToString()))`,
  `try{$sb=[ScriptBlock]::Create($src)}catch{[Console]::Error.WriteLine($_.Exception.InnerException.Message);exit 254}`,
  `$global:LASTEXITCODE=0;$ok=$true`,
  `& $sb 2>&1|%{if($_ -is [Management.Automation.ErrorRecord]){$ok=$false;[Console]::Error.WriteLine($_.ToString())}else{$_|Out-String -Stream -Width 4096}}`,
  `if($LASTEXITCODE){exit $LASTEXITCODE};if(-not $ok){exit 1};exit 0`,
].join(";");

function utf16Base64(text: string): string {
  const bytes = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = code >> 8;
  }
  return Buffer.from(bytes).toString("base64");
}

export const WINDOWS_COMMAND = `powershell -NoProfile -NonInteractive -EncodedCommand ${utf16Base64(WINDOWS_WRAPPER)}`;

/** The script as base64 lines of 76 characters, then the sentinel. */
export function windowsStdin(script: string): string {
  const b64 = Buffer.from(script, "utf8").toString("base64");
  return (b64.match(/.{1,76}/g) ?? []).join("\n") + "\n.\n";
}

const POSIX_COMMAND = `sh -c 'command -v bash >/dev/null 2>&1 && exec bash -s || exec sh -s'`;

export function posixQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

export function powershellQuote(word: string): string {
  return `'${word.replaceAll("'", "''")}'`;
}

/** Build the argv and stdin that run `command` on a host of the given OS. */
export function plan(host: string | undefined, os: Os, command: string, cwd?: string): { argv: string[]; stdin: string } {
  if (os === "windows") {
    const script = (cwd ? `Set-Location -LiteralPath ${powershellQuote(cwd)} -ErrorAction Stop\n` : "") + command;
    const argv = host ? [...SSH, host, "--", WINDOWS_COMMAND] : ["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", WINDOWS_COMMAND.split(" ").at(-1)!];
    return { argv, stdin: windowsStdin(script) };
  }
  const script = (cwd ? `cd -- ${posixQuote(cwd)} || exit 1\n` : "") + command + "\n";
  return { argv: host ? [...SSH, host, "--", POSIX_COMMAND] : ["bash", "-s"], stdin: script };
}

/** Old Windows OpenSSH still wraps some PowerShell stderr in CLIXML. Keep only the error text. */
export function cleanStderr(stderr: string): string {
  if (!stderr.includes("#< CLIXML")) return stderr;
  const errors = [...stderr.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => m[1]!.replaceAll("_x000D__x000A_", "\n"));
  const rest = stderr.replace(/#< CLIXML\r?\n?/g, "").replace(/<Objs[\s\S]*?<\/Objs>/g, "");
  return (rest + errors.join("")).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export async function execOn(run: Spawn, host: string | undefined, os: Os, command: string, cwd: string | undefined, timeoutMs: number) {
  const { argv, stdin } = plan(host, os, command, cwd);
  const began = Date.now();
  const result = await run(argv, stdin, timeoutMs);
  // Windows ends lines with CRLF. Give every OS the same line endings.
  const lf = (text: string) => (os === "windows" ? text.replaceAll("\r\n", "\n") : text);
  return { ...result, stdout: lf(result.stdout), stderr: lf(cleanStderr(result.stderr)), elapsedMs: Date.now() - began };
}
