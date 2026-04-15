import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";

import {
  WeChatClient,
  MessageItemType,
  generateId,
  getMimeFromFilename,
  normalizeAccountId,
  type MessageItem,
  type WeixinMessage,
} from "../src/index.js";
import { resolveConfig, type ServiceConfig } from "./config.js";
import { JsonStore } from "./store.js";
import { UserStore } from "./user-store.js";
import {
  createEmptySession,
  type HistoryEntry,
  type MonitorState,
  type SessionFile,
  type StreamEventType,
  type UserRecord,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CreateApiServerOptions {
  config?: Partial<ServiceConfig>;
}

interface MultipartFieldValue {
  value?: unknown;
}

interface PendingLogin {
  id: string;
  promise: Promise<void>;
  abortController: AbortController;
  qrcodeUrl?: string;
  status: string;
  userId?: string;
  apiKey?: string;
  error?: string;
}

interface SseClient {
  id: string;
  send: (event: StreamEventType, payload: unknown) => void;
  close: () => void;
}

interface UserState {
  client?: WeChatClient;
  session: SessionFile;
  history: HistoryEntry[];
  syncBuf?: string;
  monitor: MonitorState;
  monitorPromise?: Promise<void>;
  contextRefreshPromise?: Promise<void>;
  monitorRunId?: string;
  monitorStopReason?: string;
  sseClients: Set<SseClient>;
}

// ---------------------------------------------------------------------------
// Rate limiter — sliding window per API key
// ---------------------------------------------------------------------------

interface RateLimitBucket {
  timestamps: number[];
  windowMs: number;
  max: number;
}

function createBucket(windowMs: number, max: number): RateLimitBucket {
  return { timestamps: [], windowMs, max };
}

function checkRateLimit(bucket: RateLimitBucket): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const cutoff = now - bucket.windowMs;
  bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);
  if (bucket.timestamps.length >= bucket.max) {
    const oldest = bucket.timestamps[0];
    return { ok: false, retryAfterMs: oldest + bucket.windowMs - now };
  }
  bucket.timestamps.push(now);
  return { ok: true, retryAfterMs: 0 };
}

function nowIso(): string {
  return new Date().toISOString();
}

function truncate(value: string, maxLength = 80): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function hasSessionCredentials(session: SessionFile): boolean {
  return Boolean(session.accountId && session.token);
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

function describeMessage(msg: WeixinMessage): string {
  const text = WeChatClient.extractText(msg).trim();
  const kinds = new Set<string>();

  for (const item of msg.item_list ?? []) {
    switch (item.type) {
      case MessageItemType.TEXT:
        break;
      case MessageItemType.IMAGE:
        kinds.add("image");
        break;
      case MessageItemType.VIDEO:
        kinds.add("video");
        break;
      case MessageItemType.FILE:
        kinds.add("file");
        break;
      case MessageItemType.VOICE:
        kinds.add("voice");
        break;
      default:
        kinds.add(`type:${item.type ?? "unknown"}`);
        break;
    }
  }

  const parts: string[] = [];
  if (text) {
    parts.push(`text="${truncate(text)}"`);
  }
  if (kinds.size > 0) {
    parts.push(Array.from(kinds).join(", "));
  }

  return parts.join(" | ") || "empty message";
}

function shouldAutoReplyPing(msg: WeixinMessage): boolean {
  return WeChatClient.extractText(msg).trim() === "/ping";
}

function sanitizeFilename(fileName: string): string {
  const base = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
  return base || "upload.bin";
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readMultipartField(
  fields: Record<string, MultipartFieldValue | MultipartFieldValue[] | undefined>,
  name: string,
): string | undefined {
  const rawField = fields[name];
  if (!rawField) return undefined;

  const field = Array.isArray(rawField) ? rawField[0] : rawField;
  return asNonEmptyString(field?.value);
}

function makeEntry(params: {
  direction: HistoryEntry["direction"];
  eventType: HistoryEntry["eventType"];
  summary: string;
  payload: unknown;
  userId?: string;
  messageId?: string;
}): HistoryEntry {
  return {
    id: generateId("history"),
    direction: params.direction,
    createdAt: nowIso(),
    eventType: params.eventType,
    userId: params.userId,
    messageId: params.messageId,
    summary: params.summary,
    payload: params.payload,
  };
}

function resolveDownloadInfo(
  item: MessageItem,
  messageId: string,
  fileName?: string,
): { fileName: string; contentType: string } {
  if (item.type === MessageItemType.FILE) {
    const resolvedFileName = sanitizeFilename(
      fileName ?? item.file_item?.file_name ?? `file-${messageId}.bin`,
    );
    return {
      fileName: resolvedFileName,
      contentType: getMimeFromFilename(resolvedFileName),
    };
  }

  if (item.type === MessageItemType.IMAGE) {
    return {
      fileName: `image-${messageId}.jpg`,
      contentType: "image/jpeg",
    };
  }

  if (item.type === MessageItemType.VIDEO) {
    return {
      fileName: `video-${messageId}.mp4`,
      contentType: "video/mp4",
    };
  }

  return {
    fileName: `voice-${messageId}.silk`,
    contentType: "audio/silk",
  };
}

// ---------------------------------------------------------------------------
// Extract API key from request
// ---------------------------------------------------------------------------

function extractApiKey(request: FastifyRequest): string | undefined {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  const xApiKey = request.headers["x-api-key"];
  if (typeof xApiKey === "string") {
    return xApiKey.trim();
  }
  const query = request.query as Record<string, unknown>;
  if (typeof query?.apiKey === "string") {
    return query.apiKey.trim();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------

export async function createApiServer(
  options: CreateApiServerOptions = {},
): Promise<FastifyInstance> {
  const resolved = resolveConfig(
    options.config?.adminPassword
      ? { ...process.env, ADMIN_PASSWORD: options.config.adminPassword }
      : process.env,
  );
  const config: ServiceConfig = {
    ...resolved,
    ...options.config,
    dataDir: path.resolve(options.config?.dataDir ?? resolved.dataDir),
  };

  // User store
  const userStore = new UserStore(config.dataDir);
  await userStore.load();

  // Per-user runtime state
  const userStates = new Map<string, UserState>();
  const pendingLogins = new Map<string, PendingLogin>();

  const app = Fastify({
    logger: false,
    ajv: {
      customOptions: {
        coerceTypes: true,
      },
    },
  });

  // Allow POST JSON endpoints to accept an empty body when the client still
  // sends `Content-Type: application/json`.
  const defaultJsonParser = app.getDefaultJsonParser("error", "ignore");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (request, body, done) => {
      const rawBody =
        typeof body === "string" ? body : body.toString("utf-8");

      if (rawBody.length === 0) {
        done(null, {});
        return;
      }

      defaultJsonParser(request, rawBody, done);
    },
  );

  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "wechat-ilink-client Multi-User API",
        version: "0.2.0",
        description:
          "Multi-user WeChat iLink API with QR code login and API key authentication.",
      },
      components: {
        securitySchemes: {
          apiKey: {
            type: "apiKey",
            in: "header",
            name: "X-API-Key",
          },
          bearerAuth: {
            type: "http",
            scheme: "bearer",
          },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    staticCSP: true,
  });

  await app.register(multipart);

  // -------------------------------------------------------------------------
  // Per-user state management
  // -------------------------------------------------------------------------

  function getUserState(userId: string): UserState {
    let state = userStates.get(userId);
    if (!state) {
      state = {
        session: createEmptySession(),
        history: [],
        monitor: { running: false },
        sseClients: new Set(),
      };
      userStates.set(userId, state);
    }
    return state;
  }

  async function initUserState(user: UserRecord): Promise<UserState> {
    const store = userStore.getStoreForUser(user.userId);
    await store.ensure();

    const loadedSession = (await store.readSession()) ?? user.session;
    const loadedMessages = (await store.readMessages()).slice(-config.maxHistory);
    const loadedSyncBuf = await store.readSyncBuf();

    const state: UserState = {
      session: loadedSession,
      history: loadedMessages,
      syncBuf: loadedSyncBuf,
      monitor: { running: false },
      sseClients: new Set(),
    };

    if (hasSessionCredentials(state.session)) {
      if (state.session.loginStatus === "idle") {
        state.session.loginStatus = "confirmed";
      }
      state.client = buildClientForUser(user.userId, state);
    }

    userStates.set(user.userId, state);
    return state;
  }

  function buildClientForUser(userId: string, state: UserState): WeChatClient {
    const client = new WeChatClient({
      accountId: state.session.accountId,
      token: state.session.token,
      baseUrl: state.session.baseUrl,
    });

    for (const entry of state.history) {
      if (entry.direction !== "inbound") continue;
      if (typeof entry.payload !== "object" || !entry.payload) continue;

      const payload = entry.payload as Partial<WeixinMessage>;
      if (
        typeof payload.from_user_id === "string" &&
        typeof payload.context_token === "string" &&
        payload.context_token.length > 0
      ) {
        client.setContextToken(payload.from_user_id, payload.context_token);
      }
    }

    client.on("message", (msg: WeixinMessage) => {
      void (async () => {
        await appendHistory(userId, makeEntry({
          direction: "inbound",
          eventType: "message",
          summary: describeMessage(msg),
          userId: msg.from_user_id,
          messageId: msg.message_id != null ? String(msg.message_id) : undefined,
          payload: msg,
        }), "message");

        if (
          !shouldAutoReplyPing(msg) ||
          !msg.from_user_id ||
          !msg.context_token
        ) {
          return;
        }

        try {
          const clientId = await client.sendText(
            msg.from_user_id,
            "pong",
            msg.context_token,
          );
          await appendHistory(userId, makeEntry({
            direction: "outbound",
            eventType: "message",
            summary: `Auto replied to ${msg.from_user_id}: "pong"`,
            userId: msg.from_user_id,
            messageId: clientId,
            payload: {
              toUserId: msg.from_user_id,
              text: "pong",
              clientId,
              trigger: "/ping",
            },
          }), "message");
        } catch (error) {
          emitRuntimeError(
            userId,
            `Auto reply failed: ${error instanceof Error ? error.message : String(error)}`,
            serializeError(error),
          );
        }
      })();
    });

    client.on("error", (error: Error) => {
      emitRuntimeError(userId, error.message, serializeError(error));
    });

    client.on("sessionExpired", () => {
      void (async () => {
        state.session.loginStatus = "failed";
        state.session.lastMessage = "Session expired. Re-login may be required.";
        await persistSession(userId);
        await appendHistory(userId, makeEntry({
          direction: "system",
          eventType: "sessionExpired",
          summary: "Session expired",
          payload: { message: state.session.lastMessage },
        }), "sessionExpired");
      })();
    });

    return client;
  }

  async function persistSession(userId: string): Promise<void> {
    const state = userStates.get(userId);
    if (!state) return;
    const store = userStore.getStoreForUser(userId);
    await store.writeSession(state.session);
    await userStore.updateUserSession(userId, state.session);
  }

  async function persistHistory(userId: string): Promise<void> {
    const state = userStates.get(userId);
    if (!state) return;
    if (state.history.length > config.maxHistory) {
      state.history = state.history.slice(-config.maxHistory);
    }
    const store = userStore.getStoreForUser(userId);
    await store.writeMessages(state.history);
  }

  async function appendHistory(
    userId: string,
    entry: HistoryEntry,
    streamEvent?: StreamEventType,
  ): Promise<void> {
    const state = userStates.get(userId);
    if (!state) return;
    state.history.push(entry);
    await persistHistory(userId);

    if (streamEvent) {
      for (const client of state.sseClients) {
        client.send(streamEvent, entry);
      }
    }
  }

  function hasInboundHistoryMessage(state: UserState, messageId?: string): boolean {
    if (!messageId) return false;
    return state.history.some(
      (entry) =>
        entry.direction === "inbound" &&
        entry.messageId === messageId,
    );
  }

  async function syncPendingMessagesForUser(userId: string, state: UserState): Promise<void> {
    const client = state.client;
    if (!client || state.monitor.running || !hasSessionCredentials(state.session)) {
      return;
    }
    if (state.contextRefreshPromise) {
      await state.contextRefreshPromise;
      return;
    }

    const refreshPromise = (async () => {
      try {
        const resp = await client.api.getUpdates(state.syncBuf ?? "", 1_000);
        const isApiError =
          (resp.ret !== undefined && resp.ret !== 0) ||
          (resp.errcode !== undefined && resp.errcode !== 0);

        if (isApiError) {
          await appendHistory(userId, makeEntry({
            direction: "system",
            eventType: "error",
            summary: `Context refresh failed: ${resp.errmsg ?? `ret=${resp.ret} errcode=${resp.errcode}`}`,
            payload: resp,
          }), "error");
          return;
        }

        if (typeof resp.get_updates_buf === "string") {
          state.syncBuf = resp.get_updates_buf;
          await userStore.getStoreForUser(userId).writeSyncBuf(resp.get_updates_buf);
        }

        for (const msg of resp.msgs ?? []) {
          if (msg.context_token && msg.from_user_id) {
            client.setContextToken(msg.from_user_id, msg.context_token);
          }

          const messageId =
            msg.message_id != null ? String(msg.message_id) : undefined;
          if (hasInboundHistoryMessage(state, messageId)) {
            continue;
          }

          await appendHistory(userId, makeEntry({
            direction: "inbound",
            eventType: "message",
            summary: describeMessage(msg),
            userId: msg.from_user_id,
            messageId,
            payload: msg,
          }), "message");
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        await appendHistory(userId, makeEntry({
          direction: "system",
          eventType: "error",
          summary: `Context refresh failed: ${truncate(message)}`,
          payload: serializeError(error),
        }), "error");
      }
    })();

    state.contextRefreshPromise = refreshPromise;
    try {
      await refreshPromise;
    } finally {
      if (state.contextRefreshPromise === refreshPromise) {
        state.contextRefreshPromise = undefined;
      }
    }
  }

  function emitRuntimeError(userId: string, message: string, payload: unknown): void {
    const state = userStates.get(userId);
    if (!state) return;
    state.monitor.lastError = message;
    void (async () => {
      await appendHistory(userId, makeEntry({
        direction: "system",
        eventType: "error",
        summary: message,
        payload,
      }), "error");
    })();
  }

  async function stopMonitorForUser(userId: string, reason = "Monitor stopped"): Promise<void> {
    const state = userStates.get(userId);
    if (!state || !state.monitor.running || !state.client) return;

    state.monitorStopReason = reason;
    state.client.stop();
    try {
      await state.monitorPromise;
    } catch {
      // handled
    }
  }

  async function startMonitorForUser(userId: string): Promise<void> {
    const state = userStates.get(userId);
    if (!state || !state.client || !hasSessionCredentials(state.session)) return;
    if (state.monitor.running) return;

    const runId = generateId("monitor");
    const store = userStore.getStoreForUser(userId);

    state.monitor.running = true;
    state.monitor.lastStartedAt = nowIso();
    state.monitor.lastError = undefined;
    state.monitorRunId = runId;
    state.monitorStopReason = undefined;

    state.monitorPromise = state.client
      .start({
        loadSyncBuf: async () => state.syncBuf,
        saveSyncBuf: async (buf) => {
          state.syncBuf = buf;
          await store.writeSyncBuf(buf);
        },
      })
      .catch((error) => {
        if (state.monitorRunId !== runId) return;
        if (error instanceof Error && error.message === "aborted") return;
        emitRuntimeError(
          userId,
          error instanceof Error ? error.message : String(error),
          serializeError(error),
        );
      })
      .finally(() => {
        if (state.monitorRunId !== runId) return;
        const reason = state.monitorStopReason ?? "Monitor stopped";
        state.monitor.running = false;
        state.monitor.lastStoppedAt = nowIso();
        state.monitorPromise = undefined;
        state.monitorRunId = undefined;
        state.monitorStopReason = undefined;

        void appendHistory(userId, makeEntry({
          direction: "system",
          eventType: "monitor",
          summary: reason,
          payload: monitorSnapshot(state),
        }), "monitor");
      });
  }

  function sessionSnapshot(state: UserState): Record<string, unknown> {
    return {
      connected: hasSessionCredentials(state.session),
      monitoring: state.monitor.running,
      ...state.session,
    };
  }

  function monitorSnapshot(state: UserState): Record<string, unknown> {
    return {
      running: state.monitor.running,
      lastStartedAt: state.monitor.lastStartedAt,
      lastStoppedAt: state.monitor.lastStoppedAt,
      lastError: state.monitor.lastError,
    };
  }

  function resolveContextToken(
    client: WeChatClient,
    userId: string,
    explicit?: string,
  ): string | undefined {
    return asNonEmptyString(explicit) ?? client.getContextToken(userId);
  }

  function resolveSendContextToken(
    client: WeChatClient,
    _selfUserId: string,
    targetUserId: string,
    explicit?: string,
  ): string | undefined {
    const explicitToken = asNonEmptyString(explicit);
    if (explicitToken !== undefined) return explicitToken;

    const cached = client.getContextToken(targetUserId);
    if (cached !== undefined) return cached;

    return undefined;
  }

  async function resolveSendContextTokenWithSync(
    userId: string,
    state: UserState,
    targetUserId: string,
    explicit?: string,
  ): Promise<string | undefined> {
    const client = state.client;
    if (!client) return undefined;

    const resolved = resolveSendContextToken(
      client,
      userId,
      targetUserId,
      explicit,
    );
    if (resolved !== undefined || state.monitor.running) {
      return resolved;
    }

    await syncPendingMessagesForUser(userId, state);
    return resolveSendContextToken(client, userId, targetUserId, explicit);
  }

  function missingContextMessage(selfUserId: string, targetUserId: string): string {
    if (targetUserId === selfUserId) {
      return "No contextToken available for this account yet. Send any message to the bot from this WeChat account first, then retry.";
    }
    return "No contextToken available for this user. Receive a message first or pass contextToken explicitly.";
  }

  function ensureSelfTarget(
    reply: FastifyReply,
    selfUserId: string,
    targetUserId: string,
  ): boolean {
    if (targetUserId === selfUserId) {
      return true;
    }

    reply.code(400).send({
      message: `Only self-messaging is allowed. Use your own WeChat userId: ${selfUserId}`,
    });
    return false;
  }

  // -------------------------------------------------------------------------
  // Initialize existing users & auto-start monitors
  // -------------------------------------------------------------------------

  for (const user of userStore.listUsers()) {
    const state = await initUserState(user);
    // Auto-start monitor for users with valid sessions
    if (config.autoStartMonitor && state.client && hasSessionCredentials(state.session)) {
      console.log(`[keepalive] Auto-starting monitor for user: ${user.userId}`);
      void startMonitorForUser(user.userId);
    }
  }

  // -------------------------------------------------------------------------
  // Admin auth helper
  // -------------------------------------------------------------------------

  function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith("Basic ")) {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
      const [, password] = decoded.split(":");
      if (password === config.adminPassword) return true;
    }
    const adminPwd = request.headers["x-admin-password"];
    if (typeof adminPwd === "string" && adminPwd === config.adminPassword) return true;

    const cookie = request.headers.cookie;
    if (cookie) {
      const match = cookie.match(/admin_token=([^;]+)/);
      if (match) {
        try {
          const decoded = Buffer.from(match[1], "base64").toString("utf-8");
          if (decoded === config.adminPassword) return true;
        } catch {
          // invalid base64
        }
      }
    }

    reply.code(401).send({ message: "Unauthorized. Admin password required." });
    return false;
  }

  // -------------------------------------------------------------------------
  // API Key auth helper
  // -------------------------------------------------------------------------

  function requireApiKey(request: FastifyRequest, reply: FastifyReply): { user: UserRecord; state: UserState } | undefined {
    const apiKey = extractApiKey(request);
    if (!apiKey) {
      reply.code(401).send({ message: "API key required. Use Authorization: Bearer <key> or X-API-Key header." });
      return undefined;
    }
    const user = userStore.findByApiKey(apiKey);
    if (!user) {
      reply.code(401).send({ message: "Invalid API key." });
      return undefined;
    }
    const state = getUserState(user.userId);
    return { user, state };
  }

  // =========================================================================
  // ROUTES
  // =========================================================================

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  app.get("/health", {
    schema: {
      summary: "Health check",
      tags: ["system"],
    },
    handler: async () => ({
      ok: true,
      totalUsers: userStore.listUsers().length,
      activeUsers: userStates.size,
    }),
  });

  // -------------------------------------------------------------------------
  // Admin Auth
  // -------------------------------------------------------------------------

  app.post("/admin/login", {
    schema: {
      summary: "Admin login with password",
      tags: ["admin"],
      body: {
        type: "object",
        required: ["password"],
        properties: {
          password: { type: "string" },
        },
      },
    },
    handler: async (request, reply) => {
      const body = request.body as { password: string };
      if (body.password !== config.adminPassword) {
        return reply.code(401).send({ message: "Wrong admin password." });
      }
      return {
        ok: true,
        message: "Admin login successful.",
        token: Buffer.from(config.adminPassword).toString("base64"),
      };
    },
  });

  // -------------------------------------------------------------------------
  // Admin: User management
  // -------------------------------------------------------------------------

  app.get("/admin/users", {
    schema: {
      summary: "List all registered users",
      tags: ["admin"],
    },
    handler: async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const users = userStore.listUsers().map((u) => ({
        userId: u.userId,
        apiKey: u.apiKey,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
        connected: hasSessionCredentials(u.session),
        monitoring: userStates.get(u.userId)?.monitor.running ?? false,
      }));
      return { users };
    },
  });

  app.delete("/admin/users/:userId", {
    schema: {
      summary: "Delete a user",
      tags: ["admin"],
      params: {
        type: "object",
        required: ["userId"],
        properties: {
          userId: { type: "string" },
        },
      },
    },
    handler: async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const params = request.params as { userId: string };
      const decoded = decodeURIComponent(params.userId);

      const state = userStates.get(decoded);
      if (state) {
        await stopMonitorForUser(decoded);
        for (const sse of state.sseClients) {
          sse.close();
        }
        state.sseClients.clear();
        userStates.delete(decoded);
      }

      const deleted = await userStore.deleteUser(decoded);
      if (!deleted) {
        return reply.code(404).send({ message: "User not found." });
      }
      return { ok: true, message: `User ${decoded} deleted.` };
    },
  });

  // -------------------------------------------------------------------------
  // Auth: QR login -> returns API key
  // -------------------------------------------------------------------------

  app.post("/auth/login", {
    schema: {
      summary: "Start QR login (returns loginId to poll for status)",
      tags: ["auth"],
    },
    handler: async (_request, reply) => {
      const loginId = generateId("login");
      const loginClient = new WeChatClient();
      const abortController = new AbortController();

      const pending: PendingLogin = {
        id: loginId,
        promise: Promise.resolve(),
        abortController,
        status: "starting",
      };
      pendingLogins.set(loginId, pending);

      // Start login in background — do NOT await it
      const loginPromise = (async () => {
        try {
          const result = await loginClient.login({
            signal: abortController.signal,
            onQRCode: async (url) => {
              console.log(`[login:${loginId}] QR code generated: ${url}`);
              pending.qrcodeUrl = url;
              pending.status = "wait";
            },
            onStatus: (status) => {
              console.log(`[login:${loginId}] Status: ${status}`);
              pending.status = status;
            },
          });

          if (!result.connected || !result.botToken || !result.accountId) {
            pending.status = "failed";
            pending.error = result.message;
            return;
          }

          // Success — find or create user
          const wechatUserId = result.userId
            ?? `${normalizeAccountId(result.accountId)}@im.wechat`;

          const session: SessionFile = {
            accountId: normalizeAccountId(result.accountId),
            token: result.botToken,
            baseUrl: result.baseUrl,
            userId: wechatUserId,
            loginStatus: "confirmed",
            lastMessage: result.message,
            loginFinishedAt: nowIso(),
          };

          let user = userStore.findByUserId(wechatUserId);
          if (user) {
            user = (await userStore.updateUserSession(wechatUserId, session))!;
          } else {
            user = await userStore.createUser(wechatUserId, session);
          }

          // Init / re-init user runtime state
          const state = await initUserState(user);
          state.client = buildClientForUser(user.userId, state);

          // Auto-start monitor
          if (config.autoStartMonitor) {
            console.log(`[login:${loginId}] Login success, auto-starting monitor for ${user.userId}`);
            void startMonitorForUser(user.userId);
          }

          pending.status = "confirmed";
          pending.userId = user.userId;
          pending.apiKey = user.apiKey;
        } catch (error) {
          pending.status = abortController.signal.aborted ? "cancelled" : "failed";
          pending.error = error instanceof Error ? error.message : String(error);
          console.error(`[login:${loginId}] Error:`, pending.error);
        }
      })();

      pending.promise = loginPromise;

      // Return immediately with loginId — client polls /auth/login/:loginId
      return reply.code(202).send({
        loginId,
        status: "starting",
        message: "Login started. Poll /auth/login/:loginId for QR code and status.",
      });
    },
  });

  app.get("/auth/login/:loginId", {
    schema: {
      summary: "Poll login status",
      tags: ["auth"],
      params: {
        type: "object",
        required: ["loginId"],
        properties: {
          loginId: { type: "string" },
        },
      },
    },
    handler: async (request, reply) => {
      const params = request.params as { loginId: string };
      const pending = pendingLogins.get(params.loginId);
      if (!pending) {
        return reply.code(404).send({ message: "Login task not found." });
      }
      return {
        loginId: pending.id,
        status: pending.status,
        qrcodeUrl: pending.qrcodeUrl,
        userId: pending.userId,
        apiKey: pending.apiKey,
        error: pending.error,
      };
    },
  });

  app.delete("/auth/login/:loginId", {
    schema: {
      summary: "Cancel a login",
      tags: ["auth"],
      params: {
        type: "object",
        required: ["loginId"],
        properties: {
          loginId: { type: "string" },
        },
      },
    },
    handler: async (request, reply) => {
      const params = request.params as { loginId: string };
      const pending = pendingLogins.get(params.loginId);
      if (!pending) {
        return reply.code(404).send({ message: "Login task not found." });
      }
      pending.abortController.abort();
      try { await pending.promise; } catch { /* handled */ }
      pendingLogins.delete(params.loginId);
      return { ok: true, message: "Login cancelled." };
    },
  });

  // -------------------------------------------------------------------------
  // Rate limit buckets: sendBuckets (30/min), statusBuckets (60/min)
  // -------------------------------------------------------------------------

  const sendBuckets = new Map<string, RateLimitBucket>();
  const statusBuckets = new Map<string, RateLimitBucket>();

  function getBucket(
    map: Map<string, RateLimitBucket>,
    key: string,
    windowMs: number,
    max: number,
  ): RateLimitBucket {
    let b = map.get(key);
    if (!b) { b = createBucket(windowMs, max); map.set(key, b); }
    return b;
  }

  // -------------------------------------------------------------------------
  // POST /send — send a text message to yourself (rate limited: 30/min)
  // -------------------------------------------------------------------------

  app.post("/send", {
    schema: {
      summary: "Send a text message",
      description: "Send a WeChat text message. Rate limited to **30 requests per minute** per API key.",
      tags: ["API"],
      body: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", minLength: 1, description: "Message content" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            clientId: { type: "string", description: "Message ID returned by WeChat" },
          },
        },
        400: {
          type: "object",
          properties: {
            message: { type: "string" },
          },
        },
        503: {
          type: "object",
          properties: {
            message: { type: "string" },
          },
        },
        429: {
          type: "object",
          properties: {
            message: { type: "string" },
            retryAfterMs: { type: "integer" },
          },
        },
      },
    },
    handler: async (request, reply) => {
      const auth = requireApiKey(request, reply);
      if (!auth) return;

      // Rate limit: 30 req/min
      const bucket = getBucket(sendBuckets, auth.user.userId, 60_000, 30);
      const limit = checkRateLimit(bucket);
      if (!limit.ok) {
        return reply
          .code(429)
          .header("Retry-After", String(Math.ceil(limit.retryAfterMs / 1000)))
          .send({ message: "Rate limit exceeded. Max 30 messages per minute.", retryAfterMs: limit.retryAfterMs });
      }

      const client = auth.state.client;
      if (!client || !hasSessionCredentials(auth.state.session)) {
        return reply.code(503).send({ message: "WeChat session is not active. Please log in again." });
      }

      const body = request.body as { text: string };
      const toUserId = auth.user.userId;

      const contextToken = await resolveSendContextTokenWithSync(
        auth.user.userId,
        auth.state,
        toUserId,
        undefined,
      );
      if (contextToken === undefined) {
        return reply.code(400).send({
          message: missingContextMessage(auth.user.userId, toUserId),
        });
      }

      const clientId = await client.sendText(toUserId, body.text, contextToken);
      await appendHistory(auth.user.userId, makeEntry({
        direction: "outbound",
        eventType: "message",
        summary: `Sent: "${truncate(body.text)}"`,
        userId: toUserId,
        messageId: clientId,
        payload: { toUserId, text: body.text, clientId },
      }), "message");

      return { ok: true, clientId };
    },
  });

  // -------------------------------------------------------------------------
  // GET /status — check if session is online (rate limited: 60/min)
  // -------------------------------------------------------------------------

  app.get("/status", {
    schema: {
      summary: "Check account online status",
      description: "Returns whether the WeChat account session is active. Rate limited to **60 requests per minute** per API key.",
      tags: ["API"],
      response: {
        200: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            online: { type: "boolean", description: "True if session is active and monitor is running" },
            userId: { type: "string" },
            monitoring: { type: "boolean" },
            lastError: { type: "string", nullable: true },
          },
        },
        429: {
          type: "object",
          properties: {
            message: { type: "string" },
            retryAfterMs: { type: "integer" },
          },
        },
      },
    },
    handler: async (request, reply) => {
      const auth = requireApiKey(request, reply);
      if (!auth) return;

      // Rate limit: 60 req/min
      const bucket = getBucket(statusBuckets, auth.user.userId, 60_000, 60);
      const limit = checkRateLimit(bucket);
      if (!limit.ok) {
        return reply
          .code(429)
          .header("Retry-After", String(Math.ceil(limit.retryAfterMs / 1000)))
          .send({ message: "Rate limit exceeded. Max 60 status checks per minute.", retryAfterMs: limit.retryAfterMs });
      }

      const connected = hasSessionCredentials(auth.state.session);
      const monitoring = auth.state.monitor.running;
      return {
        ok: true,
        online: connected && monitoring,
        userId: auth.user.userId,
        monitoring,
        lastError: auth.state.monitor.lastError ?? null,
      };
    },
  });

  // -------------------------------------------------------------------------
  // /me/apikey/reset — regenerate API key (keep for UI)
  // -------------------------------------------------------------------------

  app.post("/me/apikey/reset", {
    schema: {
      summary: "Regenerate API key",
      tags: ["account"],
    },
    handler: async (request, reply) => {
      const auth = requireApiKey(request, reply);
      if (!auth) return;
      const updated = await userStore.regenerateApiKey(auth.user.userId);
      if (!updated) {
        return reply.code(404).send({ message: "User not found." });
      }
      return {
        ok: true,
        userId: updated.userId,
        apiKey: updated.apiKey,
        message: "API key has been regenerated. Old key is now invalid.",
      };
    },
  });

  // -------------------------------------------------------------------------
  // /me — current user info (for UI only, not part of user-facing API)
  // -------------------------------------------------------------------------

  app.get("/me", {
    schema: {
      summary: "Get current user info",
      tags: ["account"],
    },
    handler: async (request, reply) => {
      const auth = requireApiKey(request, reply);
      if (!auth) return;
      return {
        userId: auth.user.userId,
        apiKey: auth.user.apiKey,
        createdAt: auth.user.createdAt,
        lastLoginAt: auth.user.lastLoginAt,
        online: hasSessionCredentials(auth.state.session) && auth.state.monitor.running,
        monitoring: auth.state.monitor.running,
        lastError: auth.state.monitor.lastError ?? null,
      };
    },
  });


  // (old /me/* routes removed — only /send, /status, /me/apikey/reset, /me remain)

  // -------------------------------------------------------------------------
  // Web UI — serve static files from service/public/
  // -------------------------------------------------------------------------

  const publicDir = path.join(
    import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
    "public",
  );

  app.get("/", {
    schema: { hide: true },
    handler: async (_request, reply) => {
      const html = await fs.readFile(path.join(publicDir, "index.html"), "utf-8");
      return reply.type("text/html").send(html);
    },
  });

  app.get("/admin", {
    schema: { hide: true },
    handler: async (_request, reply) => {
      const html = await fs.readFile(path.join(publicDir, "index.html"), "utf-8");
      return reply.type("text/html").send(html);
    },
  });

  app.get("/ui/*", {
    schema: { hide: true },
    handler: async (request, reply) => {
      const params = request.params as { "*": string };
      const filePath = path.join(publicDir, params["*"]);
      try {
        const content = await fs.readFile(filePath);
        const ext = path.extname(filePath);
        const mimeMap: Record<string, string> = {
          ".html": "text/html",
          ".css": "text/css",
          ".js": "application/javascript",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".ico": "image/x-icon",
        };
        return reply.type(mimeMap[ext] ?? "application/octet-stream").send(content);
      } catch {
        return reply.code(404).send("Not found");
      }
    },
  });

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  app.addHook("onClose", async () => {
    for (const [userId, state] of userStates) {
      for (const client of state.sseClients) {
        client.close();
      }
      state.sseClients.clear();
      await stopMonitorForUser(userId, "Monitor stopped by server shutdown");
    }
    userStates.clear();
    pendingLogins.clear();
  });

  await app.ready();
  return app;
}
