// Wire shapes shared by the server, the host worker, and the app. zod only, so
// the app can import the runtime schemas without pulling in the plugin SDK.
import { z } from "zod";

export const hostStatusSchema = z
  .object({
    platform: z.string(),
    arch: z.string(),
    supported: z.boolean(),
    reason: z.string().nullable(),
    version: z.string(),
    installed: z.boolean(),
    running: z.boolean(),
  })
  .strict();
export type HostStatus = z.infer<typeof hostStatusSchema>;

/** Something the user approves: a Windows app, or a pseudo-app such as the clipboard. */
export const appSchema = z.object({ key: z.string().min(1), name: z.string().min(1) }).strict();
export type App = z.infer<typeof appSchema>;

export const APPROVAL_RENDERER_ID = "computer-use-windows-approval";

export const approvalPayloadSchema = z
  .object({
    app: appSchema,
    tool: z.string(),
    purpose: z.string().nullable(),
  })
  .strict();
export type ApprovalPayload = z.infer<typeof approvalPayloadSchema>;

export const decisionSchema = z.enum(["thread", "always", "deny"]);
export type Decision = z.infer<typeof decisionSchema>;
export const approvalResponseSchema = z.object({ decision: decisionSchema }).strict();

export const settingsSchema = z
  .object({
    hostId: z.string().nullable(),
    status: hostStatusSchema.nullable(),
    error: z.string().nullable(),
    alwaysAllowed: z.array(appSchema),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;
