// Frontend entry: the approval card agents trigger, and the settings page.
// React and @get-bb/plugin-sdk/app come from the Cloudroom app at runtime.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  useRpc,
  type PluginPendingInteractionProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract";
import { APPROVAL_RENDERER_ID, approvalPayloadSchema, type App, type Decision, type Settings } from "./schemas";
import { Button } from "@/components/ui/button";

function requestSentence(app: App) {
  switch (app.key) {
    case "whole-screen":
      return <>The agent wants to capture <span className="font-semibold">the whole screen</span>.</>;
    case "clipboard":
      return <>The agent wants to read or change <span className="font-semibold">the clipboard</span>.</>;
    case "browser-pages":
      return <>The agent wants to control <span className="font-semibold">web pages in your browsers</span>.</>;
    case "default-browser":
      return <>The agent wants to open links in <span className="font-semibold">your default web browser</span>.</>;
    default:
      return <>The agent wants to see and control <span className="font-semibold">{app.name}</span>.</>;
  }
}

function ApprovalCard({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const parsed = useMemo(() => approvalPayloadSchema.safeParse(interaction.payload), [interaction.payload]);
  const [busy, setBusy] = useState(false);
  if (!parsed.success)
    return (
      <Button variant="outline" onClick={() => void cancel().catch(() => undefined)}>
        Dismiss invalid request
      </Button>
    );
  const { app, purpose } = parsed.data;
  const decide = async (decision: Decision) => {
    setBusy(true);
    try {
      await submit({ decision });
    } catch {
      // The card stays up; the user can choose again.
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="space-y-4"
      onKeyDown={(event) => {
        if (event.key === "Escape") void decide("deny");
      }}
    >
      <div className="space-y-1">
        <p className="text-sm text-foreground">{requestSentence(app)}</p>
        {purpose ? <p className="text-xs text-muted-foreground">{purpose}</p> : null}
        <p className="text-xs text-muted-foreground">
          It works in the background with its own cursor. Screen content may be sent to the model.
        </p>
      </div>
      <div className="flex flex-col-reverse gap-2 border-t border-border/70 pt-4 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void decide("deny")}>
          Deny
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void decide("thread")}>
          Only this thread
        </Button>
        <Button type="button" size="sm" disabled={busy} onClick={() => void decide("always")}>
          Always allow
        </Button>
      </div>
    </div>
  );
}

function SettingsPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    (pending: Promise<Settings>) =>
      pending.then(
        (value) => {
          setSettings(value);
          setError(null);
        },
        (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
      ),
    [],
  );
  useEffect(() => {
    void load(rpc.call("getSettings", null));
  }, [rpc, load]);
  if (!settings) return <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>;
  const status = settings.status;
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Agents in Local threads can see and control Windows desktop apps with{" "}
        <code className="text-xs">room-cli computer-use</code>. Cloudroom asks you before each new app.
      </p>
      {status ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {status.supported
              ? `Cua Driver ${status.version} · ${status.installed ? "installed" : "downloads on first use"} · ${status.running ? "running" : "idle"}`
              : status.reason}
          </p>
          {status.supported ? (
            <Button size="sm" variant="ghost" onClick={() => void load(rpc.call("restart", null))}>
              Restart driver
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-destructive">{settings.error}</p>
      )}
      <div className="space-y-2">
        <p className="text-sm font-medium">Always allowed</p>
        {settings.alwaysAllowed.length === 0 ? (
          <p className="text-xs text-muted-foreground">None yet.</p>
        ) : (
          settings.alwaysAllowed.map((app) => (
            <div key={app.key} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">
                {app.name} <span className="text-xs text-muted-foreground">{app.key}</span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void load(rpc.call("removeAlwaysAllowed", { key: app.key }))}
              >
                Remove
              </Button>
            </div>
          ))
        )}
      </div>
      <p className="text-xs text-muted-foreground">Powered by Cua Driver (MIT).</p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({ id: APPROVAL_RENDERER_ID, component: ApprovalCard });
  app.slots.settingsSection({ id: "configuration", component: SettingsPage });
});
