import { spawnSync } from "node:child_process";

const r = spawnSync("openclaw", ["--version"], { encoding: "utf8" });
if (r.status !== 0) {
  console.error(r.stdout || r.stderr);
  process.exit(r.status ?? 1);
}
console.log("openclaw ok:", r.stdout.trim());
