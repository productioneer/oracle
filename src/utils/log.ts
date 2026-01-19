import fs from "fs";
import path from "path";
import { ensureDir } from "./fs.js";
import { nowIso } from "./time.js";

export type Logger = (message: string) => void;

export async function createLogger(logPath: string): Promise<Logger> {
  await ensureDir(path.dirname(logPath));
  const stream = fs.createWriteStream(logPath, { flags: "a" });
  return (message: string) => {
    const line = `[${nowIso()}] ${message}`;
    stream.write(`${line}\n`);
  };
}
