// Host worker: runs on the Windows machine inside Cloudroom's host daemon.
// Installs the pinned Cua Driver (checksum + Authenticode publisher checked),
// keeps one driver daemon on a private named pipe, and runs tool calls on it.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  experimental_defineHostEntry,
  type ExperimentalHostPaths,
  type ExperimentalHostRpcContext,
  type ExperimentalHostWorkerLease,
} from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract";
import { DRIVER, assetFor, keyForImage, type App } from "./driver";
import type { HostStatus } from "./schemas";

const IDLE_STOP_MS = 2 * 60_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

const windowsDir = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
const system32 = (...parts: string[]) => join(windowsDir, "System32", ...parts);
const POWERSHELL = system32("WindowsPowerShell", "v1.0", "powershell.exe");

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * The user's environment minus Cloudroom and Electron internals. Apps the
 * driver launches inherit it: a leaked ELECTRON_RUN_AS_NODE would make
 * VS Code, Slack, or any Electron app start as plain Node and exit.
 */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(ELECTRON_|BB_|ROOM_|CUA_DRIVER)/i.test(key) || /^NODE_(OPTIONS|ENV)$/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, CUA_DRIVER_RS_TELEMETRY_ENABLED: "false", CUA_DRIVER_RS_UPDATE_CHECK: "false", ...extra };
}

/** Spawn a process, feed `input` on stdin, and collect its output (bounded, cancellable). */
function runProcess(
  file: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: options.env ?? childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let stoppedBecause: string | null = null;
    const stop = (reason: string) => {
      if (stoppedBecause) return;
      stoppedBecause = reason;
      child.kill();
    };
    const timer = setTimeout(() => stop(`timed out after ${Math.round(options.timeoutMs / 1000)}s`), options.timeoutMs);
    const onAbort = () => stop("was cancelled");
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const settle = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) stop("produced too much output");
      else chunks.push(chunk);
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
    child.once("error", (error) => {
      settle();
      reject(error);
    });
    child.once("close", (code) => {
      settle();
      const stderr = Buffer.concat(err).toString("utf8");
      resolve({
        exitCode: stoppedBecause ? 1 : (code ?? 1),
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: stoppedBecause ? `${stderr}\nThe command ${stoppedBecause}.`.trim() : stderr,
      });
    });
  });
}

/** Run a PowerShell script. Inputs travel in environment variables, never in the script text. */
async function powershell(script: string, env: Record<string, string>, timeoutMs = 60_000): Promise<string> {
  const result = await runProcess(
    POWERSHELL,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { env: { ...process.env, ...env }, timeoutMs },
  );
  if (result.exitCode !== 0)
    throw new Error(result.stdout.trim() || result.stderr.trim() || `PowerShell exited with ${result.exitCode}`);
  return result.stdout;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/** Every executable must carry a valid Authenticode signature from Cua AI, Inc. */
async function verifyPublisher(files: string[]): Promise<void> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "foreach ($file in ($env:CU_VERIFY_FILES | ConvertFrom-Json)) { $sig = Get-AuthenticodeSignature -LiteralPath $file; $subject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '' }; if ($sig.Status -ne 'Valid' -or -not $subject.Contains($env:CU_VERIFY_PUBLISHER)) { Write-Output ('Signature check failed for ' + [IO.Path]::GetFileName($file) + ': ' + $sig.Status + ' ' + $subject); exit 3 } }",
    "Write-Output OK",
  ].join("; ");
  const out = await powershell(script, {
    CU_VERIFY_FILES: JSON.stringify(files),
    CU_VERIFY_PUBLISHER: DRIVER.publisher,
  });
  if (out.trim() !== "OK") throw new Error(`Cua Driver signature check failed: ${out.trim()}`);
}

async function unzip(archive: string, destination: string, signal: AbortSignal): Promise<void> {
  // Windows 10 1803+ ships bsdtar, which reads zip files. Expand-Archive is the fallback.
  const tar = await runProcess(system32("tar.exe"), ["-xf", archive, "-C", destination], {
    env: process.env,
    timeoutMs: 5 * 60_000,
    signal,
  }).catch((error: unknown) => ({ exitCode: 1, stdout: "", stderr: String(error) }));
  if (tar.exitCode === 0) return;
  await powershell(
    "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:CU_ZIP -DestinationPath $env:CU_OUT -Force",
    { CU_ZIP: archive, CU_OUT: destination },
    5 * 60_000,
  );
}

async function install(dir: string, signal: AbortSignal): Promise<void> {
  const asset = assetFor(process.platform, process.arch);
  if (!asset) throw new Error(`Computer use is not available on ${process.platform}-${process.arch}.`);
  const parent = dirname(dir);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(parent, ".install-"));
  try {
    const archive = join(stage, "driver.zip");
    const response = await fetch(`${DRIVER.releaseUrl}/${asset.file}`, { signal });
    if (!response.ok || !response.body) throw new Error(`Cua Driver download failed (HTTP ${response.status}).`);
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(archive));
    if ((await sha256(archive)) !== asset.sha256)
      throw new Error("Cua Driver download failed its checksum; nothing was installed.");
    const unpacked = join(stage, "driver");
    await mkdir(unpacked);
    await unzip(archive, unpacked, signal);
    await verifyPublisher(DRIVER.executables.map((name) => join(unpacked, name)));
    const version = await runProcess(join(unpacked, "cua-driver.exe"), ["--version"], { timeoutMs: 30_000, signal });
    if (version.stdout.trim() !== `cua-driver ${DRIVER.version}`)
      throw new Error(`Unexpected Cua Driver version: ${(version.stdout || version.stderr).trim()}`);
    const hashes: Record<string, string> = {};
    for (const name of DRIVER.executables) hashes[name] = await sha256(join(unpacked, name));
    await writeFile(join(unpacked, "verified.json"), JSON.stringify({ version: DRIVER.version, sha256: hashes }, null, 2));
    await rm(dir, { recursive: true, force: true });
    await rename(unpacked, dir);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

/** Replace `<name>_png_b64` / `<name>_jpeg_b64` fields with `<name>_file` paths, so screenshots stay out of the transcript. */
async function saveImages(stdout: string, shotsDir: string): Promise<string> {
  if (!stdout.includes("_b64")) return stdout;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.replace(CONTROL_CHARS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`));
  } catch {
    return stdout;
  }
  const writes: Array<{ file: string; data: Buffer }> = [];
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const match = /^(.*)_(png|jpeg|jpg)_b64$/.exec(key);
      if (match && typeof entry === "string") {
        const ext = match[2] === "png" ? "png" : "jpg";
        const file = join(shotsDir, `${match[1]}-${Date.now()}-${randomUUID().slice(0, 6)}.${ext}`);
        writes.push({ file, data: Buffer.from(entry, "base64") });
        out[`${match[1]}_file`] = file;
      } else out[key] = visit(entry);
    }
    return out;
  };
  const result = visit(parsed);
  if (writes.length === 0) return stdout;
  await mkdir(shotsDir, { recursive: true });
  await Promise.all(writes.map(({ file, data }) => writeFile(file, data)));
  return JSON.stringify(result, null, 2);
}

function createHostEntry() {
  let paths: ExperimentalHostPaths | null = null;
  let verified = false;
  let installing: Promise<void> | null = null;
  let installMs: number | null = null;
  let daemon: ChildProcess | null = null;
  let pipePath: string | null = null;
  let lease: ExperimentalHostWorkerLease | null = null;
  let lastUsed = 0;
  let driverExits = 0;
  const sessions = new Set<string>();
  const descriptions = new Map<string, string>();

  const requirePaths = () => {
    if (!paths) throw new Error("Host paths are not known yet.");
    return paths;
  };
  const dir = () => join(requirePaths().dataDir, "cua-driver", DRIVER.version);
  const binary = () => join(dir(), "cua-driver.exe");
  const home = () => join(requirePaths().dataDir, "driver-home");
  const driverEnv = (extra: Record<string, string> = {}) => childEnv({ CUA_DRIVER_RS_HOME: home(), ...extra });

  function unsupported(): string | null {
    if (process.platform !== "win32")
      return "This plugin drives Windows desktops only. On a Mac, use Cloudroom's built-in Computer Use.";
    if (!assetFor(process.platform, process.arch)) return `Computer use is not available on Windows ${process.arch}.`;
    return null;
  }

  async function status(): Promise<HostStatus> {
    const reason = unsupported();
    return {
      platform: process.platform,
      arch: process.arch,
      supported: reason === null,
      reason,
      version: DRIVER.version,
      installed: paths !== null && reason === null && (await exists(join(dir(), "verified.json"))),
      running: daemon !== null && daemon.exitCode === null,
    };
  }

  async function matchesRecord(): Promise<boolean> {
    try {
      const record = JSON.parse(await readFile(join(dir(), "verified.json"), "utf8")) as {
        sha256?: Record<string, string>;
      };
      for (const name of DRIVER.executables)
        if ((await sha256(join(dir(), name))) !== record.sha256?.[name]) return false;
      return true;
    } catch {
      return false;
    }
  }

  async function ensureInstalled(signal: AbortSignal): Promise<void> {
    if (verified) return;
    if (!installing && (await matchesRecord())) {
      verified = true;
      return;
    }
    const started = Date.now();
    installing ??= install(dir(), signal)
      .then(() => {
        installMs = Date.now() - started;
      })
      .finally(() => {
        installing = null;
      });
    await installing;
    verified = true;
  }

  function stopDaemon(): void {
    const child = daemon;
    daemon = null;
    pipePath = null;
    sessions.clear();
    if (child && child.exitCode === null) {
      // Closing stdin is the driver's parent-liveness signal: it shuts down cleanly.
      child.stdin?.end();
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }, 3_000).unref();
    }
    void lease?.dispose();
    lease = null;
  }

  function reachable(path: string): Promise<boolean> {
    return new Promise((resolve) => {
      const client = connect(path);
      client.once("connect", () => {
        client.end();
        resolve(true);
      });
      client.once("error", () => resolve(false));
    });
  }

  async function ensureDaemon(context: ExperimentalHostRpcContext): Promise<string> {
    const reason = unsupported();
    if (reason) throw new Error(reason);
    await ensureInstalled(context.lifecycle.signal);
    lastUsed = Date.now();
    if (daemon && daemon.exitCode === null && pipePath) return pipePath;
    await mkdir(home(), { recursive: true });
    const path = `\\\\.\\pipe\\cloudroom-computer-use-${process.pid}-${randomUUID().slice(0, 8)}`;
    const logFile = join(home(), "driver.log");
    const log = await open(logFile, "w");
    const child = spawn(binary(), ["serve", "--socket", path], {
      env: driverEnv({ CUA_DRIVER_PARENT_LIVENESS_STDIN: "1" }),
      stdio: ["pipe", "ignore", log.fd],
      windowsHide: true,
    });
    await log.close();
    child.once("error", () => {});
    child.stdin?.on("error", () => {});
    child.once("exit", () => {
      if (daemon !== child) return;
      driverExits++;
      stopDaemon();
    });
    daemon = child;
    pipePath = path;
    lease ??= context.experimental_retainWorker();
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null || child.pid === undefined) break;
      if (await reachable(path)) return path;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    stopDaemon();
    const tail = (await readFile(logFile, "utf8").catch(() => "")).slice(-2_000);
    throw new Error(`Cua Driver did not start. ${tail.trim()}`.trim());
  }

  /** Friendly name from the executable's version info, e.g. "Notepad". Cached per app. */
  async function describeProcess(pid: number): Promise<string | null> {
    try {
      const out = await powershell(
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); (Get-Process -Id ([int]$env:CU_PID)).Description",
        { CU_PID: String(pid) },
        15_000,
      );
      const text = out.trim();
      return text && text.length <= 120 ? text : null;
    } catch {
      return null;
    }
  }

  async function appForPid(pid: number): Promise<App | null> {
    const result = await runProcess(system32("tasklist.exe"), ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      env: process.env,
      timeoutMs: 15_000,
    });
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /^"([^"]+)","(\d+)"/.exec(line.trim());
      if (!match?.[1] || Number(match[2]) !== pid) continue;
      const image = match[1];
      const key = keyForImage(image);
      let name = descriptions.get(key);
      if (name === undefined) {
        name = (await describeProcess(pid)) ?? image;
        descriptions.set(key, name);
      }
      return { key, name: name === image ? image : `${name} (${image})` };
    }
    return null;
  }

  const timer = setInterval(() => {
    if (daemon && Date.now() - lastUsed > IDLE_STOP_MS) stopDaemon();
  }, 30_000);
  timer.unref();

  return experimental_defineHostEntry({
    contract: hostContract,
    handlers: {
      async status(_input, context) {
        paths = context.experimental_paths;
        return status();
      },
      async prepare(_input, context) {
        paths = context.experimental_paths;
        if (!unsupported()) await ensureInstalled(context.lifecycle.signal);
        const reported = installMs;
        installMs = null;
        return { ...(await status()), installMs: reported };
      },
      async call(input, context) {
        paths = context.experimental_paths;
        sessions.add(input.session);
        const path = await ensureDaemon(context);
        const result = await runProcess(binary(), ["call", "--socket", path, input.tool], {
          input: JSON.stringify(input.args),
          env: driverEnv(),
          timeoutMs: CALL_TIMEOUT_MS,
          signal: context.signal,
        });
        lastUsed = Date.now();
        const exits = driverExits;
        driverExits = 0;
        return { ...result, stdout: await saveImages(result.stdout, input.shotsDir), driverExits: exits };
      },
      async release({ session }) {
        if (!sessions.delete(session) || !daemon || !pipePath) return null;
        if (sessions.size === 0) stopDaemon();
        else
          await runProcess(binary(), ["call", "--socket", pipePath, "end_session"], {
            input: JSON.stringify({ session }),
            env: driverEnv(),
            timeoutMs: 10_000,
          }).catch(() => undefined);
        return null;
      },
      async describe(input, context) {
        paths = context.experimental_paths;
        const reason = unsupported();
        if (reason) throw new Error(reason);
        await ensureInstalled(context.lifecycle.signal);
        const args = input.tool ? ["describe", input.tool] : ["list-tools"];
        const result = await runProcess(binary(), args, { env: driverEnv(), timeoutMs: 30_000 });
        if (result.exitCode !== 0) throw new Error((result.stderr || result.stdout).trim());
        return result.stdout;
      },
      async appForPid({ pid }) {
        if (unsupported()) return null;
        return appForPid(pid);
      },
      async restart(_input, context) {
        paths = context.experimental_paths;
        stopDaemon();
        return status();
      },
    },
    dispose() {
      clearInterval(timer);
      stopDaemon();
    },
  });
}

export default createHostEntry();
