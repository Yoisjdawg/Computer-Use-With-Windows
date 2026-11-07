// Server entry: the `room-cli computer-use` command, per-app approvals, and
// cleanup when threads go idle or away. Tool calls run on the thread's machine
// through the host worker (host.ts).
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, rpcContract } from "./contract";
import { DEFAULT_BROWSER, acceptsSession, decideGate, parseCallArgs, type App, type Gate } from "./driver";
import { APPROVAL_RENDERER_ID, appSchema, approvalResponseSchema, type Settings } from "./schemas";

const APPROVAL_WAIT_MS = 90_000;
const APPROVAL_TIMEOUT_MS = 60 * 60_000;
const APP_BUSY_MS = 60_000;
const ALWAYS_KEY = "always-allowed";
const SHOTS_ROOT = "cloudroom-computer-use-windows";

export const commands = [
  { name: "status", summary: "Show the driver and approval status", usage: "room-cli computer-use status" },
  {
    name: "setup",
    summary: "Download and verify Cua Driver now instead of on first use",
    usage: "room-cli computer-use setup",
  },
  {
    name: "tools",
    summary: "List every Cua Driver tool, or show one tool's input schema",
    usage: "room-cli computer-use tools [<tool>]",
  },
  {
    name: "call",
    summary: "Run one Cua Driver tool; Cloudroom asks the user before each new app",
    usage: "room-cli computer-use call <tool> ['<json-args>' | key=value ...] [--purpose <text>]",
  },
];
const USAGE = ["Usage:", ...commands.map((command) => `  ${command.usage}`)].join("\n");

interface CliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

function fail(code: string, message: string, exitCode = 1): CliResult {
  return { exitCode, stdout: `${JSON.stringify({ error: code, message })}\n` };
}

const json = (value: unknown): CliResult => ({ exitCode: 0, stdout: `${JSON.stringify(value, null, 2)}\n` });
const safeId = (threadId: string) => threadId.replace(/[^A-Za-z0-9_-]/g, "_");
const sessionFor = (threadId: string) => `cr-${safeId(threadId)}`.slice(0, 64);
const shotsDirFor = (threadId: string) => join(tmpdir(), SHOTS_ROOT, safeId(threadId));
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const threadSchema = z.object({ host: z.object({ id: z.string() }).nullable().optional() }).passthrough();
const hostsSchema = z.array(
  z.object({ id: z.string(), status: z.string(), machineProviderId: z.string().nullable().optional() }).passthrough(),
);

export default async function computerUseWindows(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const pending = new Map<string, Promise<unknown>>();
  const busy = new Map<string, { threadId: string; at: number }>();
  const active = new Map<string, string>();
  const threadKey = (threadId: string) => `thread/${encodeURIComponent(threadId)}`;

  // Approval lists are read-modify-write; run those writes one at a time.
  let writes: Promise<unknown> = Promise.resolve();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const next = writes.then(task, task);
    writes = next.catch(() => undefined);
    return next;
  };
  const readList = async (key: string): Promise<App[]> =>
    z.array(appSchema).catch([]).parse((await bb.storage.kv.get(key)) ?? []);
  const addTo = (key: string, app: App) =>
    serialized(async () => {
      const list = await readList(key);
      if (!list.some((entry) => entry.key === app.key)) await bb.storage.kv.set(key, [...list, app]);
    });
  const removeFrom = (key: string, appKey: string) =>
    serialized(async () => {
      await bb.storage.kv.set(
        key,
        (await readList(key)).filter((entry) => entry.key !== appKey),
      );
    });

  async function threadHostId(threadId: string): Promise<string | null> {
    const thread = threadSchema.parse(await bb.sdk.threads.get({ threadId, include: "host" }));
    return thread.host?.id ?? null;
  }

  async function localHostId(): Promise<string | null> {
    const hosts = hostsSchema.parse(await bb.sdk.hosts.list());
    return (
      hosts.find((entry) => entry.status === "connected" && !entry.machineProviderId)?.id ??
      hosts.find((entry) => entry.status === "connected")?.id ??
      null
    );
  }

  async function settings(hostId?: string | null): Promise<Settings> {
    const id = hostId === undefined ? await localHostId() : hostId;
    let status: Settings["status"] = null;
    let error: string | null = null;
    if (id) {
      try {
        status = await host.call("status", {}, { hostId: id });
      } catch (caught) {
        error = errorText(caught);
      }
    } else error = "No connected machine.";
    return { hostId: id, status, error, alwaysAllowed: await readList(ALWAYS_KEY) };
  }

  function describeDecision(app: App, value: unknown) {
    const parsed = approvalResponseSchema.safeParse(value);
    if (!parsed.success) return {};
    const title = {
      always: `Always allowed ${app.name}`,
      thread: `Allowed ${app.name} in this thread`,
      deny: `Denied ${app.name}`,
    }[parsed.data.decision];
    return { title };
  }

  /** Resolves to the scope the app is allowed in, or a CLI failure to return. */
  async function approve(args: {
    threadId: string;
    app: App;
    tool: string;
    purpose: string | null;
  }): Promise<{ scope: "always" | "thread" } | CliResult> {
    const { threadId, app } = args;
    if ((await readList(ALWAYS_KEY)).some((entry) => entry.key === app.key)) return { scope: "always" };
    if ((await readList(threadKey(threadId))).some((entry) => entry.key === app.key)) return { scope: "thread" };

    const pendingKey = `${threadId}\0${app.key}`;
    let request = pending.get(pendingKey) as ReturnType<typeof bb.ui.requestInput> | undefined;
    if (!request) {
      // The decision is recorded here, not by whichever command is waiting:
      // the user may answer after a waiting command already returned.
      request = bb.ui
        .requestInput({
          threadId,
          rendererId: APPROVAL_RENDERER_ID,
          title: `Allow this agent to use ${app.name}?`,
          payload: { app, tool: args.tool, purpose: args.purpose },
          timeoutMs: APPROVAL_TIMEOUT_MS,
          describeSubmission: (value) => describeDecision(app, value),
        })
        .then(async (result) => {
          if (result.outcome === "submitted") {
            const parsed = approvalResponseSchema.safeParse(result.value);
            if (parsed.success && parsed.data.decision !== "deny")
              await addTo(parsed.data.decision === "always" ? ALWAYS_KEY : threadKey(threadId), app);
          }
          return result;
        });
      pending.set(pendingKey, request);
      void request.finally(() => pending.delete(pendingKey)).catch(() => undefined);
    }

    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      request,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), APPROVAL_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    if (result === null)
      return fail(
        "approval_pending",
        `Cloudroom is asking the user to allow ${app.name}. Tell the user, then run the same command again. Do not end your turn.`,
        3,
      );
    if (result.outcome === "cancelled")
      return fail("approval_cancelled", `The request to use ${app.name} was cancelled (${result.reason}).`);
    const parsed = approvalResponseSchema.safeParse(result.value);
    if (!parsed.success) return fail("approval_invalid", "The approval answer was not understood. Run the same command again.");
    if (parsed.data.decision === "deny")
      return fail("app_denied", `The user denied access to ${app.name}. Do not retry; ask the user what to do instead.`);
    return { scope: parsed.data.decision };
  }

  /** An approved launch also covers the process it started, so the first action does not ask again. */
  async function grantLaunched(stdout: string, scope: "always" | "thread", threadId: string, hostId: string) {
    let pid: unknown;
    try {
      pid = (JSON.parse(stdout) as { pid?: unknown }).pid;
    } catch {
      return;
    }
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return;
    const launched = await host.call("appForPid", { pid }, { hostId }).catch(() => null);
    if (launched) await addTo(scope === "always" ? ALWAYS_KEY : threadKey(threadId), launched);
  }

  async function runCall(argv: string[], signal: AbortSignal | undefined, threadId: string, hostId: string) {
    const parsed = parseCallArgs(argv);
    if (!parsed.ok) return fail("usage", parsed.message);
    const { tool, input, purpose } = parsed;
    const gate: Gate = decideGate(tool, input);
    if (gate.kind === "error") return fail("invalid_call", gate.message);

    const status = await host.call("prepare", {}, { hostId, timeoutMs: 10 * 60_000 });
    if (status.installMs !== null) bb.log.info(`Installed Cua Driver ${status.version} in ${status.installMs}ms`);
    if (!status.supported) return fail("unsupported", status.reason ?? "Computer use is not available on this machine.");

    let app: App | null = null;
    if (gate.kind === "pid") {
      app = await host.call("appForPid", { pid: gate.pid }, { hostId });
      if (!app) return fail("app_not_found", `No running process has pid ${gate.pid}. Find it with list_windows.`);
    } else if (gate.kind === "app") app = gate.app;

    let scope: "always" | "thread" | null = null;
    if (app) {
      const holder = busy.get(app.key);
      if (holder && holder.threadId !== threadId && Date.now() - holder.at < APP_BUSY_MS)
        return fail("app_busy", `${app.name} is being used by @thread:${holder.threadId}. Wait a minute or pick another app.`);
      const approval = await approve({ threadId, app, tool, purpose });
      if ("exitCode" in approval) return approval;
      scope = approval.scope;
      busy.set(app.key, { threadId, at: Date.now() });
    }

    const session = sessionFor(threadId);
    const args = acceptsSession(tool) ? { ...input, session } : input;
    active.set(threadId, hostId);
    const result = await host.call(
      "call",
      { tool, args, session, shotsDir: shotsDirFor(threadId) },
      { hostId, timeoutMs: 150_000, ...(signal ? { signal } : {}) },
    );
    if (result.driverExits > 0) bb.log.warn(`Cua Driver exited unexpectedly (${result.driverExits}x); it restarts on the next call.`);
    if (tool === "launch_app" && result.exitCode === 0 && scope && gate.kind === "app" && gate.app.key !== DEFAULT_BROWSER.key)
      await grantLaunched(result.stdout, scope, threadId, hostId);
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  async function runCli(argv: string[], ctx: { threadId?: string; signal?: AbortSignal }): Promise<CliResult> {
    const [command, ...rest] = argv;
    if (command === undefined || command === "help" || command === "--help" || command === "-h")
      return { exitCode: 0, stdout: `${USAGE}\n` };
    const threadId = ctx.threadId;
    if (!threadId) return fail("no_thread", "Run this from a Cloudroom thread (ROOM_THREAD_ID is not set).");
    const hostId = await threadHostId(threadId);
    if (!hostId) return fail("no_host", "This thread has no local machine. Computer use for Windows works in Local threads.");
    switch (command) {
      case "status":
        return json({ ...(await settings(hostId)), allowedInThisThread: await readList(threadKey(threadId)) });
      case "setup": {
        const status = await host.call("prepare", {}, { hostId, timeoutMs: 10 * 60_000 });
        return json(status);
      }
      case "tools": {
        const status = await host.call("prepare", {}, { hostId, timeoutMs: 10 * 60_000 });
        if (!status.supported) return fail("unsupported", status.reason ?? "Computer use is not available on this machine.");
        return { exitCode: 0, stdout: await host.call("describe", { tool: rest[0] ?? null }, { hostId, timeoutMs: 60_000 }) };
      }
      case "call":
        return runCall(rest, ctx.signal, threadId, hostId);
      default:
        return fail("usage", USAGE);
    }
  }

  bb.agents.configure(() => ({ tools: [], skills: ["computer-use-windows"] }));

  bb.cli.register({
    name: "computer-use",
    summary: "See and control Windows desktop apps, with a per-app approval from the user",
    commands,
    async run(argv, ctx) {
      try {
        return await runCli(argv, ctx);
      } catch (error) {
        return fail("error", errorText(error));
      }
    },
  });

  bb.rpc.register(rpcContract, {
    getSettings: () => settings(),
    async removeAlwaysAllowed({ key }) {
      await removeFrom(ALWAYS_KEY, key);
      return settings();
    },
    async restart() {
      const hostId = await localHostId();
      if (hostId) await host.call("restart", {}, { hostId });
      return settings(hostId);
    },
  });

  host.experimental_onWorkerExit(({ hostId }) => bb.log.warn(`Host worker on ${hostId} exited unexpectedly.`));

  async function release(threadId: string) {
    for (const [key, holder] of busy) if (holder.threadId === threadId) busy.delete(key);
    const hostId = active.get(threadId);
    if (!hostId) return;
    active.delete(threadId);
    await host.call("release", { session: sessionFor(threadId) }, { hostId }).catch(() => undefined);
  }
  for (const event of ["thread.idle", "thread.failed"] as const)
    bb.events.on(event, ({ thread }) => release(thread.id));
  for (const event of ["thread.archived", "thread.deleted"] as const)
    bb.events.on(event, async ({ thread }) => {
      await bb.storage.kv.delete(threadKey(thread.id));
      await release(thread.id);
      await rm(shotsDirFor(thread.id), { recursive: true, force: true }).catch(() => undefined);
    });
}
