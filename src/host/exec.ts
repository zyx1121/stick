import { SSH, type Os, type Spawn } from "./os.ts";

function utf16Base64(text: string): string {
  const bytes = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = code >> 8;
  }
  return Buffer.from(bytes).toString("base64");
}

/**
 * Both runners print this line first, before any user code. When it is missing
 * from stdout, the runner never started, so an exit 255 came from ssh itself
 * and not from a script that exited 255 after its own inner ssh failed.
 */
export const RAN_MARKER = "stick:ran\n";

/**
 * Runs the script saved at $env:STICK_SCRIPT. It switches every stream to
 * UTF-8, reports a parse error as text, passes native stderr through without
 * calling it a failure, and exits with the last native exit code, or 1 when a
 * PowerShell error was written.
 */
const WINDOWS_RUNNER = [
  `$ErrorActionPreference="Continue";$ProgressPreference="SilentlyContinue";$env:WSL_UTF8="1"`,
  `$u=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=$u;$OutputEncoding=$u`,
  `$src=[IO.File]::ReadAllText($env:STICK_SCRIPT,$u)`,
  `try{$sb=[ScriptBlock]::Create($src)}catch{$e=$_.Exception;if($e.InnerException){$e=$e.InnerException};[Console]::Error.WriteLine($e.Message);exit 254}`,
  `$global:LASTEXITCODE=0;$ok=$true`,
  `& $sb 2>&1|%{if($_ -is [Management.Automation.ErrorRecord]){if($_.FullyQualifiedErrorId -notlike "NativeCommandError*"){$ok=$false};[Console]::Error.WriteLine($_.ToString())}else{$_|Out-String -Stream -Width 4096}}`,
  `if($LASTEXITCODE){exit $LASTEXITCODE};if(-not $ok){exit 1};exit 0`,
].join(";");

/**
 * Fixed outer PowerShell, sent as -EncodedCommand so no shell between here and
 * powershell.exe parses it. It reads the script from stdin as base64 lines up
 * to a line holding "." (Windows OpenSSH never passes end of input), saves it
 * to a temp file, and runs WINDOWS_RUNNER in a child whose stdin is an empty
 * file. Otherwise a native program in the script (git, cmd) would wait on the
 * ssh stdin that never closes.
 */
const WINDOWS_OUTER = [
  `[Console]::Out.Write("stick:ran\`n");$ProgressPreference="SilentlyContinue";$b=[Text.StringBuilder]::new()`,
  `while(($l=[Console]::In.ReadLine()) -ne $null -and $l -ne "."){[void]$b.Append($l)}`,
  `$f=[IO.Path]::GetTempFileName();$n=[IO.Path]::GetTempFileName()`,
  `[IO.File]::WriteAllBytes($f,[Convert]::FromBase64String($b.ToString()));$env:STICK_SCRIPT=$f`,
  `$p=Start-Process powershell -ArgumentList "-NoProfile -NonInteractive -EncodedCommand ${utf16Base64(WINDOWS_RUNNER)}" -NoNewWindow -Wait -PassThru -RedirectStandardInput $n`,
  `Remove-Item $f,$n -Force;exit $p.ExitCode`,
].join(";");

export const WINDOWS_COMMAND = `powershell -NoProfile -NonInteractive -EncodedCommand ${utf16Base64(WINDOWS_OUTER)}`;

/** The script as base64 lines of 76 characters, then the sentinel. */
export function windowsStdin(script: string): string {
  const b64 = Buffer.from(script, "utf8").toString("base64");
  return (b64.match(/.{1,76}/g) ?? []).join("\n") + "\n.\n";
}

export function posixQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * Save the whole script first, then run it with stdin on /dev/null. With
 * `bash -s`, a command that reads stdin (cat, read, ssh, python) would eat
 * the lines of the script that follow it.
 */
export const POSIX_RUNNER =
  `printf 'stick:ran\\n'; f=$(mktemp) || exit 125; trap "rm -f \\"\\$f\\"" EXIT; cat >"$f"; ` +
  `if command -v bash >/dev/null 2>&1; then bash "$f"; else sh "$f"; fi </dev/null`;
const POSIX_COMMAND = `sh -c ${posixQuote(POSIX_RUNNER)}`;

export function powershellQuote(word: string): string {
  return `'${word.replaceAll("'", "''")}'`;
}

/** Build the argv and stdin that run `command` on a host of the given OS. */
export function plan(host: string | undefined, os: Os, command: string, cwd?: string): { argv: string[]; stdin: string } {
  if (os === "windows") {
    // The path travels as base64, so no quote character in it (PowerShell also treats curly quotes as quotes) can end the string.
    const dir = cwd ? `Set-Location -LiteralPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(cwd, "utf8").toString("base64")}'))) -ErrorAction Stop\n` : "";
    const script = dir + command;
    const argv = host ? [...SSH, host, "--", WINDOWS_COMMAND] : ["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", WINDOWS_COMMAND.split(" ").at(-1)!];
    return { argv, stdin: windowsStdin(script) };
  }
  const script = (cwd ? `cd -- ${posixQuote(cwd)} || exit 1\n` : "") + command + "\n";
  return { argv: host ? [...SSH, host, "--", POSIX_COMMAND] : ["sh", "-c", POSIX_RUNNER], stdin: script };
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
  let stdout = lf(result.stdout);
  const ran = stdout.startsWith(RAN_MARKER);
  if (ran) stdout = stdout.slice(RAN_MARKER.length);
  return { ...result, stdout, stderr: lf(cleanStderr(result.stderr)), ran, elapsedMs: Date.now() - began };
}
