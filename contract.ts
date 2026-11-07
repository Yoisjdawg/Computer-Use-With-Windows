// RPC contracts: server <-> host worker, and app <-> server.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { appSchema, hostStatusSchema, settingsSchema } from "./schemas";

export const hostContract = defineRpcContract({
  status: { input: z.object({}).strict(), output: hostStatusSchema },
  /** Installs the pinned driver if needed (downloads on first use). */
  prepare: {
    input: z.object({}).strict(),
    output: hostStatusSchema.extend({ installMs: z.number().nullable() }),
  },
  /** Runs one driver tool. Screenshots come back as file paths under shotsDir. */
  call: {
    input: z
      .object({
        tool: z.string().min(1).max(80),
        args: z.record(z.string(), z.unknown()),
        session: z.string().min(1).max(64),
        shotsDir: z.string().min(1),
      })
      .strict(),
    output: z
      .object({
        exitCode: z.number().int(),
        stdout: z.string(),
        stderr: z.string(),
        driverExits: z.number().int(),
      })
      .strict(),
  },
  /** Ends a thread's driver session; stops the driver when no session is left. */
  release: { input: z.object({ session: z.string().min(1).max(64) }).strict(), output: z.null() },
  /** `cua-driver list-tools`, or `describe <tool>`. */
  describe: { input: z.object({ tool: z.string().max(80).nullable() }).strict(), output: z.string() },
  /** The app (executable) a process belongs to, or null when no process has that pid. */
  appForPid: {
    input: z.object({ pid: z.number().int().positive() }).strict(),
    output: appSchema.nullable(),
  },
  restart: { input: z.object({}).strict(), output: hostStatusSchema },
});

export const rpcContract = defineRpcContract({
  getSettings: { input: z.null(), output: settingsSchema },
  removeAlwaysAllowed: {
    input: z.object({ key: z.string().min(1) }).strict(),
    output: settingsSchema,
  },
  restart: { input: z.null(), output: settingsSchema },
});
