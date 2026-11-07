// Pure logic shared by the server and the host worker: the pinned Cua Driver
// release and the rules that decide which approval a tool call needs.
// No imports, so the unit tests run it directly under Node.

/** An app (or pseudo-app) the user approves. Same shape as `appSchema`. */
export type App = {
  key: string;
  name: string;
};

/**
 * The Cua Driver release this plugin pins. SHA-256 values come from the
 * release's checksums.txt; every executable in the archive is Authenticode
 * signed by the publisher below, and the installer checks both.
 */
export const DRIVER = {
  version: "0.35.2",
  releaseUrl: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.35.2",
  publisher: 'O="Cua AI, Inc."',
  executables: ["cua-driver.exe", "cua-driver-uia.exe", "cua-cursor-theme.exe"],
  assets: {
    x64: {
      file: "cua-driver-rs-0.35.2-windows-x86_64-binary.zip",
      sha256: "0eb49cb651986d2888294484be84c25a33e1cd31396e57c457f501358decdd4e",
    },
    arm64: {
      file: "cua-driver-rs-0.35.2-windows-arm64-binary.zip",
      sha256: "8a4e07c5debd614c53e9689e718074fe0f4e7247a2b4d8527406f59f49cd8025",
    },
  },
} as const;

export function assetFor(platform: string, arch: string) {
  if (platform !== "win32") return null;
  if (arch === "x64") return DRIVER.assets.x64;
  if (arch === "arm64") return DRIVER.assets.arm64;
  return null;
}

/** Tools that change the driver itself, or act on several apps in one call. */
export const BLOCKED_TOOLS = new Set([
  "set_config",
  "install_extension",
  "install_ffmpeg",
  "check_for_update",
  "replay_trajectory",
  "run_script",
  "run_steps",
]);

/** Read-only discovery: no approval, even when filtered by pid. */
const DISCOVERY_TOOLS = new Set([
  "list_apps",
  "list_windows",
  "get_screen_size",
  "get_cursor_position",
  "get_accessibility_tree",
  "check_permissions",
  "health_report",
]);

/** Tools that act on one app's window and must name it by pid. */
export const PID_REQUIRED_TOOLS = new Set([
  "bring_to_front",
  "click",
  "debug_window_info",
  "double_click",
  "drag",
  "get_window_state",
  "hotkey",
  "invoke_menu",
  "kill_app",
  "press_key",
  "right_click",
  "scroll",
  "set_value",
  "set_window_frame",
  "type_text",
  "verify_state",
  "zoom",
]);

/** Browser page tools address a DevTools target, not a pid. */
const BROWSER_TOOLS = new Set([
  "browser_click",
  "browser_dialog",
  "browser_download",
  "browser_navigate",
  "browser_pointer",
  "browser_prepare",
  "browser_set_input_files",
  "browser_type",
  "get_browser_state",
  "page",
]);

/** Every driver tool accepts `session` except these. */
const NO_SESSION_TOOLS = new Set(["list_sessions"]);

export const WHOLE_SCREEN: App = { key: "whole-screen", name: "the whole screen" };
export const CLIPBOARD: App = { key: "clipboard", name: "the clipboard" };
export const BROWSER_PAGES: App = { key: "browser-pages", name: "web pages in your browsers" };
export const DEFAULT_BROWSER: App = { key: "default-browser", name: "your default web browser" };

export type Gate =
  | { kind: "free" }
  | { kind: "pid"; pid: number }
  | { kind: "app"; app: App }
  | { kind: "error"; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

export function acceptsSession(tool: string): boolean {
  return !NO_SESSION_TOOLS.has(tool);
}

/** The executable file name in a path or command line (`"C:\x y\a.exe" --flag` gives `a.exe`). */
export function exeName(commandLine: string): string {
  let path = commandLine.trim();
  if (path.startsWith('"')) {
    const end = path.indexOf('"', 1);
    path = end === -1 ? path.slice(1) : path.slice(1, end);
  } else {
    const match = /^(.*?\.exe)(?=\s|$)/i.exec(path);
    if (match?.[1]) path = match[1];
  }
  return path.split(/[\\/]/).pop() || path;
}

/** Approval key for an executable image name: `exe:notepad` for `Notepad.exe`. */
export function keyForImage(image: string): string {
  return `exe:${image.trim().toLowerCase().replace(/\.exe$/, "")}`;
}

/** The app `launch_app` will start for this identifier (path, command line, name, or AUMID). */
export function launchTarget(identifier: string): App {
  const value = identifier.trim();
  const aumid = /^shell:appsfolder\\(.+)$/i.exec(value)?.[1] ?? (value.includes("!") ? value : null);
  if (aumid) {
    const family = aumid.split("!")[0] ?? aumid;
    return { key: `aumid:${aumid.toLowerCase()}`, name: family.split("_")[0] || aumid };
  }
  const exe = exeName(value);
  return { key: keyForImage(exe), name: exe };
}

function launchGate(input: Record<string, unknown>): Gate {
  // The driver's own precedence: launch_path > path > aumid > bundle_id > name.
  const identifier = [input.launch_path, input.path, input.aumid, input.bundle_id, input.name].find(nonEmpty);
  const urls = Array.isArray(input.urls) && input.urls.length > 0;
  if (identifier && urls)
    return { kind: "error", message: "launch_app takes either an app or urls, not both. Make two calls." };
  if (identifier) return { kind: "app", app: launchTarget(identifier) };
  if (urls) return { kind: "app", app: DEFAULT_BROWSER };
  return { kind: "error", message: "launch_app needs path, name, aumid, launch_path, or urls." };
}

/** Which approval, if any, a tool call needs before it runs. */
export function decideGate(tool: string, input: Record<string, unknown>): Gate {
  if (BLOCKED_TOOLS.has(tool))
    return {
      kind: "error",
      message: `${tool} is not available through Cloudroom: it changes Cua Driver itself or acts on several apps in one call.`,
    };
  if (DISCOVERY_TOOLS.has(tool)) return { kind: "free" };

  const target = isRecord(input.target) ? input.target : null;
  if (input.scope === "desktop" || target?.kind === "desktop") {
    if (tool === "move_cursor") return { kind: "free" };
    return {
      kind: "error",
      message: "Desktop-wide input is not allowed. Target one app: pass its pid and window_id from list_windows.",
    };
  }

  const pids = [input.pid, target?.pid].filter((value) => value !== undefined);
  if (pids.some((value) => typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0))
    return { kind: "error", message: "pid must be a positive integer." };
  const unique = [...new Set(pids as number[])];
  if (unique.length > 1)
    return { kind: "error", message: "pid and target.pid name different processes. Target one app per call." };

  if (tool === "launch_app") return launchGate(input);
  if (tool === "get_desktop_state") return { kind: "app", app: WHOLE_SCREEN };
  if (tool === "clipboard_read" || tool === "clipboard_write") return { kind: "app", app: CLIPBOARD };
  const [pid] = unique;
  if (pid !== undefined) return { kind: "pid", pid };
  if (BROWSER_TOOLS.has(tool)) return { kind: "app", app: BROWSER_PAGES };
  if (PID_REQUIRED_TOOLS.has(tool))
    return {
      kind: "error",
      message: `${tool} needs a pid so Cloudroom knows which app you are controlling. Find it with list_windows or list_apps.`,
    };
  return { kind: "free" };
}

const CALL_USAGE = "Usage: room-cli computer-use call <tool> ['<json-args>' | key=value ...] [--purpose <text>]";
const ARGS_HINT =
  "Pass the tool arguments as one JSON object ('{\"pid\":123}') or as key=value pairs (pid=123 window_id=456).";

/** A key=value value: numbers, booleans, null, and JSON arrays/objects parse; anything else stays a string. */
function pairValue(raw: string): unknown {
  if (/^-?\d+(\.\d+)?$/.test(raw) || /^(true|false|null)$/.test(raw) || /^[[{]/.test(raw)) {
    try {
      return JSON.parse(raw);
    } catch {
      // Not JSON after all: keep the text.
    }
  }
  return raw;
}

/**
 * Parse `call` arguments: `<tool> ['<json>' | key=value ...] [--purpose <text>]`.
 * key=value pairs exist for PowerShell 5.1, which strips the quotes inside a
 * JSON argument on its way to a native program.
 */
export function parseCallArgs(argv: string[]):
  | { ok: true; tool: string; input: Record<string, unknown>; purpose: string | null }
  | { ok: false; message: string } {
  const [tool, ...rest] = argv;
  if (!tool || tool.startsWith("-")) return { ok: false, message: CALL_USAGE };
  let json: Record<string, unknown> | null = null;
  const pairs: Array<[string, unknown]> = [];
  let purpose: string | null = null;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] as string;
    if (arg === "--purpose") {
      purpose = rest[++index] ?? null;
      if (purpose === null) return { ok: false, message: "--purpose needs a value." };
    } else if (arg.startsWith("--purpose=")) purpose = arg.slice("--purpose=".length);
    else if (/^\s*[[{]/.test(arg)) {
      if (json !== null) return { ok: false, message: `Pass only one JSON object. ${ARGS_HINT}` };
      let parsed: unknown;
      try {
        parsed = JSON.parse(arg);
      } catch {
        return {
          ok: false,
          message: `The JSON arguments did not parse. ${ARGS_HINT} PowerShell strips the quotes inside JSON; use key=value pairs there.`,
        };
      }
      if (!isRecord(parsed)) return { ok: false, message: ARGS_HINT };
      json = parsed;
    } else {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(arg);
      if (!match?.[1] || match[1] === "__proto__")
        return { ok: false, message: `Unexpected argument "${arg.slice(0, 80)}". ${ARGS_HINT}` };
      pairs.push([match[1], pairValue(match[2] ?? "")]);
    }
  }
  const input: Record<string, unknown> = { ...json };
  for (const [key, value] of pairs) input[key] = value;
  return { ok: true, tool, input, purpose: purpose?.trim() ? purpose.trim().slice(0, 500) : null };
}
