import { spawn } from "child_process";
import * as fs from "fs";

export interface RunGobogOpts {
  gobogBin: string;
  configPath: string;
  outputDir: string;
}

/**
 * Runs `gobog -config <cfg> -export <out>` and resolves once the process
 * exits cleanly. Streams stdout/stderr to the developer console so failures
 * surface in Obsidian's DevTools rather than disappearing silently.
 */
export function runGobogExport(opts: RunGobogOpts): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!opts.gobogBin) {
      reject(new Error("gobogBinPath is empty"));
      return;
    }
    fs.mkdirSync(opts.outputDir, { recursive: true });

    const child = spawn(
      opts.gobogBin,
      ["-config", opts.configPath, "-export", opts.outputDir],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stderr = "";
    child.stdout.on("data", (b) => console.log("[gobog]", b.toString().trimEnd()));
    child.stderr.on("data", (b) => {
      const s = b.toString();
      stderr += s;
      console.warn("[gobog]", s.trimEnd());
    });

    child.once("error", (err) => {
      reject(new Error(`failed to spawn ${opts.gobogBin}: ${err.message}`));
    });
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const tail = stderr.split("\n").filter(Boolean).slice(-3).join(" | ");
      reject(new Error(`gobog exited with code ${code}: ${tail}`));
    });
  });
}
