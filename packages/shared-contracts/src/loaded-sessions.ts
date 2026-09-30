import { z } from "zod";

import { harnessIdSchema, hostThreadIdSchema } from "./ids.js";

export const LOADED_SESSIONS_METHOD = "codexhost/resources/list";
export const loadedSessionsParamsSchema = z.strictObject({});
export const loadedSessionResourceStateSchema = z.enum([
  "loaded",
  "historyOnly",
  "suspending",
  "suspended",
  "unavailable",
]);
export const loadedSessionReleaseStatusSchema = z.enum([
  "suspended",
  "busy",
  "unknown",
  "releaseFailed",
  "unsupported",
]);
export const loadedSessionsResultSchema = z.strictObject({
  sessions: z.array(
    z.strictObject({
      threadId: hostThreadIdSchema,
      harnessId: harnessIdSchema,
      running: z.boolean(),
      resourceState: loadedSessionResourceStateSchema,
      lastActivityAt: z.number().int().nonnegative(),
      lastRelease: z
        .strictObject({
          status: loadedSessionReleaseStatusSchema,
          observedAt: z.number().int().nonnegative(),
        })
        .nullable(),
    }),
  ),
});
export type LoadedSessionResourceState = z.infer<typeof loadedSessionResourceStateSchema>;
export type LoadedSessionReleaseStatus = z.infer<typeof loadedSessionReleaseStatusSchema>;
export type LoadedSessionsResult = z.infer<typeof loadedSessionsResultSchema>;
