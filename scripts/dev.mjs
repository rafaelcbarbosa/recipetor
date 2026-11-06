import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const children = [
  spawn(process.execPath, ["server/index.js"], {
    cwd: root,
    env: {
      ...process.env,
      RECIPETOR_ORIGIN: process.env.RECIPETOR_ORIGIN || "http://localhost:5173",
    },
    stdio: "inherit",
  }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "0.0.0.0"], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  }),
];

let stopping = false;

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill(signal);
  }
}

for (const child of children) {
  child.on("error", (error) => {
    console.error("Could not start a development process:", error.message);
    process.exitCode = 1;
    stop();
  });
  child.on("exit", (code) => {
    if (!stopping) {
      process.exitCode = code ?? 1;
      stop();
    }
  });
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
