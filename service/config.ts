import path from "node:path";

export interface ServiceConfig {
  host: string;
  port: number;
  dataDir: string;
  maxHistory: number;
  adminPassword: string;
  autoStartMonitor: boolean;
}

function parseInteger(
  rawValue: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function parseBoolean(
  rawValue: string | undefined,
  fallback: boolean,
): boolean {
  if (rawValue == null) return fallback;
  const normalized = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServiceConfig {
  const host = env.HOST?.trim() || "0.0.0.0"; // bind to all interfaces for Docker by default
  const port = parseInteger(env.PORT, 3000, 1, 65535);
  const dataDir = path.resolve(env.DATA_DIR?.trim() || "./data");
  const maxHistory = parseInteger(env.MAX_HISTORY, 200, 1, 2000);
  const autoStartMonitor = parseBoolean(env.AUTO_START_MONITOR, true);

  const adminPassword = env.ADMIN_PASSWORD?.trim();
  if (!adminPassword) {
    throw new Error(
      "FATAL: ADMIN_PASSWORD environment variable is not set.\n" +
      "You must provide a password to secure the admin panel.\n" +
      "Example: docker run -e ADMIN_PASSWORD=your_secure_password ..."
    );
  }

  return { host, port, dataDir, maxHistory, adminPassword, autoStartMonitor };
}
