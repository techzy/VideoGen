import { spawn } from "node:child_process";

/** Run a command, capture stdout/stderr, reject on non-zero exit. */
export function run(cmd, args, { cwd, env, quiet = true, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
      if (!quiet) process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      if (onStderr) onStderr(String(d));
      if (!quiet) process.stderr.write(d);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const err = new Error(`${cmd} exited with code ${code}\n${stderr.slice(-2000)}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

export const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Lowercase, strip everything but letters and digits: used to compare words. */
export function normWord(s) {
  return s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9]/g, "");
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let verbose = false;
export function setVerbose(v) {
  verbose = v;
}
export function log(...args) {
  console.error("›", ...args);
}
export function debug(...args) {
  if (verbose) console.error("  ", ...args);
}
