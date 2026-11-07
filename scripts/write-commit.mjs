import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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
} catch (error) {
  console.error("Failed to write commit info:", error.message);
  // Write a fallback
  writeFileSync(join(root, "public", "commit-info.json"), JSON.stringify({ hash: "unknown", date: "", message: "" }, null, 2));
}