import type { HarnessAdapter } from "@codexhost/harness-adapter";
import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { CommandCodeAdapter } from "./command-code-adapter.js";
import { COMMAND_CODE_COMMAND_ENV } from "./command.js";

export function createHarnessAdapter(context: HarnessPluginContext): CommandCodeAdapter {
  const environment = { ...context.environment };
  return new CommandCodeAdapter({
    ...(environment[COMMAND_CODE_COMMAND_ENV]
      ? { command: environment[COMMAND_CODE_COMMAND_ENV] }
      : {}),
    environment,
  });
}

/** Best-effort catalog prefetch; a failure or slow CLI never blocks Host startup. */
export async function warmup(adapter: Pick<HarnessAdapter, "inspect">): Promise<void> {
  try {
    await adapter.inspect();
  } catch {
    /* Optional prefetch cannot fail Host startup. */
  }
}
