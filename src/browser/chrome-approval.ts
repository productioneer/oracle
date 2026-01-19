import path from "path";
import { oracleChromeDataDir } from "./profiles.js";

export function requiresPersonalChromeApproval(userDataDir: string): boolean {
  const oracleDir = path.resolve(oracleChromeDataDir());
  const resolved = path.resolve(userDataDir);
  return resolved !== oracleDir;
}
