const { spawn } = require("node:child_process");
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const frontend = path.resolve(__dirname, "../../Frontend");
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill();
  process.exitCode = code;
}
for (const [file, args, cwd] of [
  [path.join(__dirname, "preview-records.js"), [], backend],
  [
    path.join(frontend, "node_modules/vite/bin/vite.js"),
    ["--host", "127.0.0.1", "--strictPort"],
    frontend,
  ],
]) {
  const child = spawn(process.execPath, [file, ...args], {
    cwd,
    stdio: "inherit",
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) stop(code || 0);
  });
}
process.once("SIGINT", () => stop());
process.once("SIGTERM", () => stop());
