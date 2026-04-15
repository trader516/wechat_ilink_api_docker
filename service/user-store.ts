import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { JsonStore } from "./store.js";
import type { SessionFile, UserRecord } from "./types.js";

function generateApiKey(): string {
  return `wk_${crypto.randomBytes(16).toString("hex")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class UserStore {
  private users = new Map<string, UserRecord>();
  private apiKeyIndex = new Map<string, string>(); // apiKey -> userId
  private userStores = new Map<string, JsonStore>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string) {}

  private getUsersFilePath(): string {
    return path.join(this.dataDir, "users.json");
  }

  private getUserDir(userId: string): string {
    // Sanitize userId for filesystem safety
    const safe = userId.replace(/[^a-zA-Z0-9_@.-]/g, "_");
    return path.join(this.dataDir, "users", safe);
  }

  getStoreForUser(userId: string): JsonStore {
    let store = this.userStores.get(userId);
    if (!store) {
      store = new JsonStore(this.getUserDir(userId));
      this.userStores.set(userId, store);
    }
    return store;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.getUsersFilePath(), "utf-8");
      const records = JSON.parse(raw) as Record<string, UserRecord>;
      this.users.clear();
      this.apiKeyIndex.clear();
      for (const [userId, record] of Object.entries(records)) {
        this.users.set(userId, record);
        this.apiKeyIndex.set(record.apiKey, userId);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        // No users file yet — start fresh
        return;
      }
      throw error;
    }
  }

  private async persist(): Promise<void> {
    const next = this.writeQueue.then(async () => {
      const obj: Record<string, UserRecord> = {};
      for (const [userId, record] of this.users) {
        obj[userId] = record;
      }
      await fs.mkdir(path.dirname(this.getUsersFilePath()), { recursive: true });
      await fs.writeFile(
        this.getUsersFilePath(),
        `${JSON.stringify(obj, null, 2)}\n`,
        "utf-8",
      );
    });
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    await next;
  }

  findByApiKey(apiKey: string): UserRecord | undefined {
    const userId = this.apiKeyIndex.get(apiKey);
    if (!userId) return undefined;
    return this.users.get(userId);
  }

  findByUserId(userId: string): UserRecord | undefined {
    return this.users.get(userId);
  }

  listUsers(): UserRecord[] {
    return Array.from(this.users.values());
  }

  async createUser(userId: string, session: SessionFile): Promise<UserRecord> {
    const apiKey = generateApiKey();
    const now = nowIso();
    const record: UserRecord = {
      userId,
      apiKey,
      createdAt: now,
      lastLoginAt: now,
      session,
    };
    this.users.set(userId, record);
    this.apiKeyIndex.set(apiKey, userId);

    const store = this.getStoreForUser(userId);
    await store.ensure();
    await store.writeSession(session);

    await this.persist();
    return record;
  }

  async updateUserSession(
    userId: string,
    session: SessionFile,
  ): Promise<UserRecord | undefined> {
    const record = this.users.get(userId);
    if (!record) return undefined;

    record.session = session;
    record.lastLoginAt = nowIso();

    const store = this.getStoreForUser(userId);
    await store.ensure();
    await store.writeSession(session);

    await this.persist();
    return record;
  }

  async deleteUser(userId: string): Promise<boolean> {
    const record = this.users.get(userId);
    if (!record) return false;

    this.apiKeyIndex.delete(record.apiKey);
    this.users.delete(userId);

    // Remove user data directory
    const userDir = this.getUserDir(userId);
    await fs.rm(userDir, { recursive: true, force: true });

    await this.persist();
    return true;
  }

  async regenerateApiKey(userId: string): Promise<UserRecord | undefined> {
    const record = this.users.get(userId);
    if (!record) return undefined;

    this.apiKeyIndex.delete(record.apiKey);
    record.apiKey = generateApiKey();
    this.apiKeyIndex.set(record.apiKey, userId);

    await this.persist();
    return record;
  }
}
