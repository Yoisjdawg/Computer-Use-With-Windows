Agents in Local threads can see and control **Windows** desktop apps: read an
app's UI Automation tree, click, type, scroll, open menus, and take window
screenshots, all in the background with their own cursor.

## How it works

The plugin runs [Cua Driver](https://github.com/trycua/cua) 0.35.2 on your PC.
The download is pinned by SHA-256 and must be Authenticode-signed by Cua AI,
Inc. before it is installed. Telemetry and update checks are off.

## Approvals

The first time an agent targets an app, a card in the thread asks you to
**Always allow**, allow **Only this thread**, or **Deny**. The clipboard,
whole-screen capture, and browser page control each ask separately.
Desktop-wide input is refused: every action names one app.

## For agents

The bundled skill teaches the loop: find the window with `list_windows`,
observe with `get_window_state`, act once on an element, then verify with a
fresh read. Everything runs through `room-cli computer-use`.
