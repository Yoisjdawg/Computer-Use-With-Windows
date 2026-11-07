# Computer Use for Windows (Cloudroom plugin)

Cloudroom's built-in Computer Use plugin only runs on macOS and Linux. This
plugin brings the same thing to Windows: agents in Local threads see and
control Windows desktop apps with `room-cli computer-use`, and Cloudroom asks
you before each new app.

It drives apps through [Cua Driver](https://github.com/trycua/cua) 0.35.2, the
same driver and version the built-in plugin pins, using its Windows build
(UI Automation for reading, background PostMessage input, optional foreground
escalation).

## What you get

- `room-cli computer-use status | setup | tools [TOOL] | call TOOL 'JSON' [--purpose TEXT]`
- A per-app approval card in the thread: **Always allow**, **Only this thread**, or **Deny**.
  Approving a `launch_app` also covers the process it starts.
- Settings → Plugins → Computer Use for Windows: driver status, restart, and the
  always-allowed list.
- A `computer-use-windows` skill that teaches agents the loop: observe, act once, verify.

## Shell notes (Windows)

- Git Bash: `room-cli computer-use call TOOL '{"pid":1}'`. Use forward slashes in
  Windows paths inside JSON (`C:/Windows/...`): Git Bash turns `\\` into `\` before
  Cloudroom sees it.
- PowerShell: use `room-cli.cmd`, and `key=value` pairs
  (`room-cli.cmd computer-use call get_window_state pid=1 window_id=2`). Plain
  `room-cli` resolves to a `.ps1` wrapper whose output PowerShell never shows
  (it doesn't wait for `Cloudroom.exe`, a GUI-subsystem program), and PowerShell
  5.1 strips the quotes inside JSON arguments. This affects every `room-cli`
  command in PowerShell, not just this plugin.

## Safety

- The driver download is pinned by SHA-256 (from the release's `checksums.txt`),
  and every executable must carry a valid Authenticode signature from
  `Cua AI, Inc.` before it is installed. `--version` must match.
- Telemetry and update checks are off. The driver runs only while used and
  stops after 2 idle minutes; it also exits on its own if Cloudroom's host
  worker dies (stdin liveness pipe).
- Apps the driver launches get your normal environment, minus Cloudroom and
  Electron internals (`ELECTRON_RUN_AS_NODE`, `ROOM_*`, `BB_*`).
- Blocked: `run_steps`, `run_script`, `replay_trajectory`, `set_config`,
  `install_extension`, `install_ffmpeg`, `check_for_update`.
- Each needs approval: every app (by executable), the whole screen
  (`get_desktop_state`), the clipboard, and browser page tools.
- Desktop-wide input (`"scope":"desktop"`) is refused; input must name a pid.
- Screenshots are written to `%TEMP%\cloudroom-computer-use-windows\<thread>`
  and deleted when the thread is archived or deleted.

## Install

Requirements: Cloudroom 142+ on Windows 10 (1803+) or 11, x64 or arm64. No Node
or npm needed: `dist/` ships prebuilt.

Run these in a terminal (Git Bash, or `cmd`; in PowerShell use `room-cli.cmd`):

```bash
room-cli plugin disable computer-use
room-cli plugin install git:https://github.com/Yoisjdawg/cloudroom-computer-use-windows --yes
```

The first line turns off Cloudroom's built-in Computer Use plugin, which on
Windows only answers "not available on Windows yet", so this plugin can own the
`room-cli computer-use` command. The driver (~35 MB) downloads on first use, or
right away with `room-cli computer-use setup`.

Then ask any Local thread something like *"Open Notepad and type hello"*. The
first time it targets an app, approve it in the card that appears in the thread.

Update later with `room-cli plugin update computer-use-windows --yes`.

## Undo

```powershell
room-cli plugin remove computer-use-windows
room-cli plugin enable computer-use
```

Remove also deletes the plugin's approvals. The driver lives in
`%USERPROFILE%\.gui-cloudroom\plugins\computer-use-windows\host-data` and can be deleted.

## Develop

Cloudroom ships Node and npm, so nothing needs to be on PATH:

```bash
CR="$LOCALAPPDATA/Programs/Cloudroom/Cloudroom.exe"
NPM="$LOCALAPPDATA/Programs/Cloudroom/resources/app.asar.unpacked/node_modules/npm/bin/npm-cli.js"
ELECTRON_RUN_AS_NODE=1 "$CR" "$NPM" install --include=dev
room-cli plugin install path:. --yes                          # local dev install
ELECTRON_RUN_AS_NODE=1 "$CR" --test driver.test.ts            # gating unit tests
ELECTRON_RUN_AS_NODE=1 "$CR" node_modules/typescript/bin/tsc -p .   # typecheck
room-cli plugin build .                                       # commit dist/ with the change
room-cli plugin reload computer-use-windows
```

Files: `driver.ts` (pinned release + approval rules, no dependencies),
`host.ts` (install, daemon, calls; runs in the host daemon on Windows),
`server.ts` (CLI, approvals, thread cleanup), `app.tsx` (approval card,
settings), `skills/computer-use-windows/SKILL.md`.

To move to a newer Cua Driver: update `DRIVER` in `driver.ts` (version, URL,
both SHA-256 values from the release's `checksums.txt`), re-check the tool list
against the gating sets, rebuild, reload.

## License

MIT. Cua Driver is MIT-licensed by Cua AI, Inc. and is downloaded from its
official GitHub release; it is not bundled here. Not affiliated with Cloudroom
or Cua.
