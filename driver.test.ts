// Run: npm test (Node's built-in runner; Node 23.6+ strips the types).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BROWSER_PAGES,
  CLIPBOARD,
  DEFAULT_BROWSER,
  WHOLE_SCREEN,
  acceptsSession,
  assetFor,
  decideGate,
  exeName,
  keyForImage,
  launchTarget,
  parseCallArgs,
} from "./driver.ts";

test("only Windows x64 and arm64 have a driver asset", () => {
  assert.equal(assetFor("win32", "x64")?.file, "cua-driver-rs-0.35.2-windows-x86_64-binary.zip");
  assert.equal(assetFor("win32", "arm64")?.file, "cua-driver-rs-0.35.2-windows-arm64-binary.zip");
  assert.equal(assetFor("win32", "ia32"), null);
  assert.equal(assetFor("darwin", "arm64"), null);
  assert.equal(assetFor("linux", "x64"), null);
});

test("blocked tools are refused", () => {
  for (const tool of ["run_steps", "run_script", "set_config", "install_extension", "replay_trajectory"])
    assert.equal(decideGate(tool, {}).kind, "error", tool);
});

test("discovery is free, even filtered by pid", () => {
  assert.deepEqual(decideGate("list_windows", { pid: 42 }), { kind: "free" });
  assert.deepEqual(decideGate("list_apps", {}), { kind: "free" });
  assert.deepEqual(decideGate("get_screen_size", {}), { kind: "free" });
});

test("pid tools gate on the pid, and need one", () => {
  assert.deepEqual(decideGate("click", { pid: 42, element_token: "s00000001:3" }), { kind: "pid", pid: 42 });
  assert.deepEqual(decideGate("get_window_state", { pid: 7, window_id: 9 }), { kind: "pid", pid: 7 });
  assert.equal(decideGate("type_text", { text: "hi" }).kind, "error");
  assert.equal(decideGate("zoom", { window_id: 1, x1: 0, y1: 0, x2: 1, y2: 1 }).kind, "error");
});

test("target.pid counts, and must agree with pid", () => {
  assert.deepEqual(decideGate("click", { target: { kind: "window", pid: 5, window_id: 1 } }), { kind: "pid", pid: 5 });
  assert.deepEqual(decideGate("click", { pid: 5, target: { kind: "window", pid: 5, window_id: 1 } }), {
    kind: "pid",
    pid: 5,
  });
  assert.equal(decideGate("click", { pid: 5, target: { kind: "window", pid: 6, window_id: 1 } }).kind, "error");
});

test("bad pids are refused", () => {
  for (const pid of [0, -1, 1.5, "42", null]) assert.equal(decideGate("click", { pid }).kind, "error", String(pid));
});

test("desktop-wide input is refused, except moving the agent cursor", () => {
  assert.equal(decideGate("type_text", { scope: "desktop", text: "x" }).kind, "error");
  assert.equal(decideGate("click", { target: { kind: "desktop", display_id: "primary" }, x: 1, y: 1 }).kind, "error");
  assert.equal(decideGate("type_text", { pid: 5, scope: "desktop", text: "x" }).kind, "error");
  assert.deepEqual(decideGate("move_cursor", { scope: "desktop", x: 1, y: 1 }), { kind: "free" });
});

test("screen, clipboard, and browser pages are their own approvals", () => {
  assert.deepEqual(decideGate("get_desktop_state", {}), { kind: "app", app: WHOLE_SCREEN });
  assert.deepEqual(decideGate("clipboard_read", {}), { kind: "app", app: CLIPBOARD });
  assert.deepEqual(decideGate("clipboard_write", { text: "x" }), { kind: "app", app: CLIPBOARD });
  assert.deepEqual(decideGate("browser_navigate", { target_id: "t", tab_id: "1", url: "https://a.b" }), {
    kind: "app",
    app: BROWSER_PAGES,
  });
  assert.deepEqual(decideGate("browser_prepare", { pid: 99 }), { kind: "pid", pid: 99 });
});

test("launch_app gates on what the driver will actually launch", () => {
  // Driver precedence: launch_path > path > aumid > bundle_id > name.
  assert.deepEqual(decideGate("launch_app", { name: "notepad", path: "C:\\Tools\\other.exe" }), {
    kind: "app",
    app: { key: "exe:other", name: "other.exe" },
  });
  assert.deepEqual(decideGate("launch_app", { path: "C:\\Windows\\System32\\notepad.exe" }), {
    kind: "app",
    app: { key: "exe:notepad", name: "notepad.exe" },
  });
  assert.deepEqual(decideGate("launch_app", { name: "Notepad" }), {
    kind: "app",
    app: { key: "exe:notepad", name: "Notepad" },
  });
  assert.deepEqual(decideGate("launch_app", { urls: ["https://example.com"] }), { kind: "app", app: DEFAULT_BROWSER });
  assert.equal(decideGate("launch_app", { name: "notepad", urls: ["https://example.com"] }).kind, "error");
  assert.equal(decideGate("launch_app", {}).kind, "error");
});

test("AUMIDs and shell:appsFolder paths map to one key", () => {
  const aumid = "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App";
  const expected = { key: `aumid:${aumid.toLowerCase()}`, name: "Microsoft.WindowsCalculator" };
  assert.deepEqual(launchTarget(aumid), expected);
  assert.deepEqual(launchTarget(`shell:appsFolder\\${aumid}`), expected);
  assert.deepEqual(decideGate("launch_app", { bundle_id: aumid }), { kind: "app", app: expected });
});

test("executable names come out of paths and command lines", () => {
  assert.equal(exeName('"C:\\Program Files\\My App\\app.exe" --flag'), "app.exe");
  assert.equal(exeName("C:\\Program Files\\My App\\app.exe --flag"), "app.exe");
  assert.equal(exeName("notepad"), "notepad");
  assert.equal(keyForImage("Notepad.EXE"), "exe:notepad");
  assert.equal(launchTarget("C:\\Windows\\notepad.exe").key, keyForImage("notepad.exe"));
});

test("pseudo-app keys cannot be claimed by an executable", () => {
  assert.notEqual(launchTarget("clipboard.exe").key, CLIPBOARD.key);
  assert.notEqual(keyForImage("whole-screen.exe"), WHOLE_SCREEN.key);
});

test("call arguments", () => {
  assert.deepEqual(parseCallArgs(["get_window_state", '{"pid":1,"window_id":2}', "--purpose", "check the form"]), {
    ok: true,
    tool: "get_window_state",
    input: { pid: 1, window_id: 2 },
    purpose: "check the form",
  });
  assert.deepEqual(parseCallArgs(["list_windows"]), { ok: true, tool: "list_windows", input: {}, purpose: null });
  assert.equal(parseCallArgs(["click", "{pid:1}"]).ok, false); // what PowerShell 5.1 makes of '{"pid":1}'
  assert.equal(parseCallArgs(["click", "[1]"]).ok, false);
  assert.equal(parseCallArgs(["click", "{}", "{}"]).ok, false);
  assert.equal(parseCallArgs(["click", "--purpose"]).ok, false);
  assert.equal(parseCallArgs(["click", "pid"]).ok, false);
  assert.equal(parseCallArgs(["click", "__proto__=1"]).ok, false);
  assert.equal(parseCallArgs([]).ok, false);
});

test("key=value pairs, for PowerShell", () => {
  assert.deepEqual(
    parseCallArgs(["type_text", "pid=12", "window_id=34", "text=Hello world", "delay_ms=0", "--purpose=fill the form"]),
    {
      ok: true,
      tool: "type_text",
      input: { pid: 12, window_id: 34, text: "Hello world", delay_ms: 0 },
      purpose: "fill the form",
    },
  );
  const parsed = parseCallArgs([
    "click",
    "element_token=s00000002:4",
    "include_screenshot=false",
    'target={"kind":"window","pid":5,"window_id":6}',
    "path=C:\\Windows\\notepad.exe",
    "note=a=b",
    "empty=",
  ]);
  assert.deepEqual(parsed, {
    ok: true,
    tool: "click",
    input: {
      element_token: "s00000002:4",
      include_screenshot: false,
      target: { kind: "window", pid: 5, window_id: 6 },
      path: "C:\\Windows\\notepad.exe",
      note: "a=b",
      empty: "",
    },
    purpose: null,
  });
  // Pairs override the JSON object.
  assert.deepEqual(parseCallArgs(["scroll", '{"pid":1,"direction":"up"}', "direction=down"]), {
    ok: true,
    tool: "scroll",
    input: { pid: 1, direction: "down" },
    purpose: null,
  });
});

test("every tool but list_sessions takes a session", () => {
  assert.equal(acceptsSession("click"), true);
  assert.equal(acceptsSession("list_sessions"), false);
});
