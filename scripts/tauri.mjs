import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

// Prefer the user's toolchain. The task-local installation is a fallback on this Mac.
const env = { ...process.env };
if (spawnSync("cargo", ["--version"], { stdio: "ignore" }).error) {
  const root = join(homedir(), "Library", "Caches", "leaf-toolchain");
  if (existsSync(join(root, "cargo", "bin", "cargo"))) {
    env.CARGO_HOME = join(root, "cargo");
    env.RUSTUP_HOME = join(root, "rustup");
    env.PATH = join(root, "cargo", "bin") + delimiter + env.PATH;
  }
}
const { run } = await import("@tauri-apps/cli");
Object.assign(process.env, env);
try {
  await run(process.argv.slice(2), "npm run tauri");
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
