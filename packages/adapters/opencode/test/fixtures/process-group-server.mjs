import { spawn } from "node:child_process";
import { once } from "node:events";

const child = spawn(
  process.execPath,
  [
    "-e",
    'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1_000);',
  ],
  { stdio: ["ignore", "pipe", "ignore"] },
);

await once(child.stdout, "data");
process.stdout.write(`fixture-child-pid=${child.pid}\n`);
process.stdout.write("opencode server listening on http://127.0.0.1:4300\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
