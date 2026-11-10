import { execSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, "..");

try {
  const commitHash = execSync("git rev-parse --short HEAD", { cwd: root, encoding: "utf-8" }).trim();
  const commitDate = execSync("git log -1 --format=%ci", { cwd: root, encoding: "utf-8" }).trim();
  const commitMessage = execSync("git log -1 --format=%s", { cwd: root, encoding: "utf-8" }).trim();

  const commitInfo = {
    hash: commitHash,
    date: commitDate,
    message: commitMessage,
  };

  writeFileSync(join(root, "public", "commit-info.json"), JSON.stringify(commitInfo, null, 2));
  console.log(`Commit info written: ${commitHash}`);

  // Generate service worker with commit hash in cache name
  const swTemplate = readFileSync(join(root, "public", "sw.template.js"), "utf-8");
  const swContent = swTemplate.replace("__COMMIT_HASH__", commitHash);
  writeFileSync(join(root, "public", "sw.js"), swContent);
  console.log(`Service worker generated with cache version: ${commitHash}`);
} catch (error) {
  console.error("Failed to write commit info:", error.message);
  const fallback = { hash: "unknown", date: "", message: "" };
  writeFileSync(join(root, "public", "commit-info.json"), JSON.stringify(fallback, null, 2));
  
  const swTemplate = readFileSync(join(root, "public", "sw.template.js"), "utf-8");
  const swContent = swTemplate.replace("__COMMIT_HASH__", "unknown");
  writeFileSync(join(root, "public", "sw.js"), swContent);
}