import fs from "node:fs/promises";
import path from "node:path";

import type { HistoryEntry, SessionFile } from "./types.js";

export class JsonStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string) {}

  getSessionPath(): string {
    return path.join(this.dataDir, "session.json");
  }

  getSyncBufPath(): string {
    return path.join(this.dataDir, "sync-buf.json");
  }

  getMessagesPath(): string {
    return path.join(this.dataDir, "messages.json");
  }

  getTempDir(): string {
    return path.join(this.dataDir, "tmp");
  }

  async ensure(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.mkdir(this.getTempDir(), { recursive: true });
  }

  async readSession(): Promise<SessionFile | null> {
    return this.readJson<SessionFile>(this.getSessionPath());
  }

  async writeSession(session: SessionFile): Promise<void> {
    await this.writeJson(this.getSessionPath(), session);
  }

  async clearSession(): Promise<void> {
    await this.removeFile(this.getSessionPath());
  }

  async readSyncBuf(): Promise<string | undefined> {
    const payload = await this.readJson<{ buf?: string }>(
      this.getSyncBufPath(),
    );
    return payload?.buf || undefined;
  }

  async writeSyncBuf(buf: string): Promise<void> {
    await this.writeJson(this.getSyncBufPath(), { buf });
  }

  async clearSyncBuf(): Promise<void> {
    await this.removeFile(this.getSyncBufPath());
  }

  async readMessages(): Promise<HistoryEntry[]> {
    const payload = await this.readJson<HistoryEntry[]>(
      this.getMessagesPath(),
    );
    return Array.isArray(payload) ? payload : [];
  }

  async writeMessages(messages: HistoryEntry[]): Promise<void> {
    await this.writeJson(this.getMessagesPath(), messages);
  }

  async clearMessages(): Promise<void> {
    await this.removeFile(this.getMessagesPath());
  }

  async clearTemp(): Promise<void> {
    await this.enqueue(async () => {
      await fs.rm(this.getTempDir(), { recursive: true, force: true });
      await fs.mkdir(this.getTempDir(), { recursive: true });
    });
  }

  private async readJson<T>(filePath: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw) as T;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    await this.enqueue(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        `${JSON.stringify(value, null, 2)}\n`,
        "utf-8",
      );
    });
  }

  private async removeFile(filePath: string): Promise<void> {
    await this.enqueue(async () => {
      await fs.rm(filePath, { force: true });
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(task, task);
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
