import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApiServer } from "../service/app.js";
import type { ServiceConfig } from "../service/config.js";
import type { UserRecord } from "../service/types.js";
import { ApiClient } from "../src/api/client.js";
import { WeChatClient } from "../src/index.js";

async function withApp(
  run: (app: Awaited<ReturnType<typeof createApiServer>>, dataDir: string) => Promise<void>,
  options: {
    setupDataDir?: (dataDir: string) => Promise<void>;
    config?: Partial<ServiceConfig>;
  } = {},
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-ilink-api-"));
  await options.setupDataDir?.(dataDir);

  const app = await createApiServer({
    config: {
      adminPassword: "test-admin-password",
      dataDir,
      host: "127.0.0.1",
      port: 3000,
      maxHistory: 20,
      autoStartMonitor: false,
      ...options.config,
    },
  });

  try {
    await run(app, dataDir);
  } finally {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function writeFixtureUser(dataDir: string, user: UserRecord): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "users.json"),
    `${JSON.stringify({ [user.userId]: user }, null, 2)}\n`,
    "utf-8",
  );
}

async function writeFixtureMessages(
  dataDir: string,
  userId: string,
  messages: unknown[],
): Promise<void> {
  const safeUserId = userId.replace(/[^a-zA-Z0-9_@.-]/g, "_");
  const userDir = path.join(dataDir, "users", safeUserId);
  await fs.mkdir(userDir, { recursive: true });
  await fs.writeFile(
    path.join(userDir, "messages.json"),
    `${JSON.stringify(messages, null, 2)}\n`,
    "utf-8",
  );
}

test("GET /health returns service readiness", async () => {
  await withApp(async (app) => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      ok: true,
      totalUsers: 0,
      activeUsers: 0,
    });
  });
});

test("GET /me requires API key", async () => {
  await withApp(async (app) => {
    const response = await app.inject({
      method: "GET",
      url: "/me",
    });

    assert.equal(response.statusCode, 401);
    assert.match(response.json().message, /API key required/i);
  });
});

test("POST /admin/login validates request body", async () => {
  await withApp(async (app) => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/login",
      payload: {},
    });

    assert.equal(response.statusCode, 400);
  });
});

test("Swagger UI is registered", async () => {
  await withApp(async (app) => {
    const response = await app.inject({
      method: "GET",
      url: "/docs",
    });

    assert.ok(response.statusCode === 200 || response.statusCode === 302);
    const spec = app.swagger() as {
      openapi?: string;
      paths?: Record<string, unknown>;
    };
    assert.equal(spec.openapi, "3.0.3");
    assert.ok(spec.paths?.["/health"]);
    assert.ok(spec.paths?.["/send"]);
  });
});

test("POST /auth/login accepts empty JSON body", async () => {
  const originalLogin = WeChatClient.prototype.login;
  WeChatClient.prototype.login = (async function mockLogin(opts = {}) {
    await opts.onQRCode?.("https://example.test/qr");
    return {
      connected: false,
      message: "mock login stopped",
    };
  }) as typeof WeChatClient.prototype.login;

  try {
    await withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/login",
        headers: {
          "content-type": "application/json",
        },
      });

      assert.equal(response.statusCode, 202);
      const payload = response.json();
      assert.match(payload.loginId, /^login:/);
      assert.equal(payload.status, "starting");
    });
  } finally {
    WeChatClient.prototype.login = originalLogin;
  }
});

test("POST /send restores context token from history", async () => {
  const user: UserRecord = {
    userId: "self-user@im.wechat",
    apiKey: "wk_test_self",
    createdAt: "2026-04-13T00:00:00.000Z",
    lastLoginAt: "2026-04-13T00:00:00.000Z",
    session: {
      accountId: "bot-im-bot",
      token: "bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      userId: "self-user@im.wechat",
      loginStatus: "confirmed",
      lastMessage: "Login successful!",
    },
  };

  const originalSendText = WeChatClient.prototype.sendText;
  WeChatClient.prototype.sendText = (async function mockSendText(
    to: string,
    text: string,
    contextToken?: string,
  ) {
    assert.equal(to, user.userId);
    assert.equal(text, "hello self");
    assert.equal(contextToken, "ctx-from-history");
    return "client-id-self";
  }) as typeof WeChatClient.prototype.sendText;

  try {
    await withApp(
      async (app) => {
        const response = await app.inject({
          method: "POST",
          url: "/send",
          headers: {
            "x-api-key": user.apiKey,
          },
          payload: {
            text: "hello self",
          },
        });

        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json(), {
          ok: true,
          clientId: "client-id-self",
        });
      },
      {
        setupDataDir: async (dataDir) => {
          await writeFixtureUser(dataDir, user);
          await writeFixtureMessages(dataDir, user.userId, [
            {
              id: "history-1",
              direction: "inbound",
              createdAt: "2026-04-13T00:00:01.000Z",
              eventType: "message",
              userId: user.userId,
              messageId: "msg-1",
              summary: "text=\"hi\"",
              payload: {
                from_user_id: user.userId,
                context_token: "ctx-from-history",
                item_list: [
                  {
                    type: 1,
                    text_item: { text: "hi" },
                  },
                ],
              },
            },
          ]);
        },
      },
    );
  } finally {
    WeChatClient.prototype.sendText = originalSendText;
  }
});

test("POST /send requires prior inbound context for self-send", async () => {
  const user: UserRecord = {
    userId: "self-user@im.wechat",
    apiKey: "wk_test_self_only",
    createdAt: "2026-04-13T00:00:00.000Z",
    lastLoginAt: "2026-04-13T00:00:00.000Z",
    session: {
      accountId: "bot-im-bot",
      token: "bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      userId: "self-user@im.wechat",
      loginStatus: "confirmed",
      lastMessage: "Login successful!",
    },
  };

  const originalGetUpdates = ApiClient.prototype.getUpdates;
  ApiClient.prototype.getUpdates = (async function mockGetUpdates(getUpdatesBuf: string) {
    assert.equal(getUpdatesBuf, "");
    return {
      ret: 0,
      msgs: [],
      get_updates_buf: "",
    };
  }) as typeof ApiClient.prototype.getUpdates;

  try {
    await withApp(
      async (app) => {
        const response = await app.inject({
          method: "POST",
          url: "/send",
          headers: {
            "x-api-key": user.apiKey,
          },
          payload: {
            text: "hello self without context",
          },
        });

        assert.equal(response.statusCode, 400);
        assert.match(
          response.json().message,
          /Send any message to the bot from this WeChat account first/i,
        );
      },
      {
        setupDataDir: async (dataDir) => {
          await writeFixtureUser(dataDir, user);
        },
      },
    );
  } finally {
    ApiClient.prototype.getUpdates = originalGetUpdates;
  }
});

test("POST /send backfills context from pending updates when monitor is stopped", async () => {
  const user: UserRecord = {
    userId: "self-user@im.wechat",
    apiKey: "wk_test_refresh_context",
    createdAt: "2026-04-13T00:00:00.000Z",
    lastLoginAt: "2026-04-13T00:00:00.000Z",
    session: {
      accountId: "bot-im-bot",
      token: "bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      userId: "self-user@im.wechat",
      loginStatus: "confirmed",
      lastMessage: "Login successful!",
    },
  };

  const originalGetUpdates = ApiClient.prototype.getUpdates;
  const originalSendText = WeChatClient.prototype.sendText;

  ApiClient.prototype.getUpdates = (async function mockGetUpdates(
    getUpdatesBuf: string,
    timeoutMs?: number,
  ) {
    assert.equal(getUpdatesBuf, "");
    assert.equal(timeoutMs, 1_000);
    return {
      ret: 0,
      get_updates_buf: "buf-after-refresh",
      msgs: [
        {
          message_id: 7449426402296260000,
          from_user_id: user.userId,
          to_user_id: "bot@im.bot",
          context_token: "ctx-from-refresh",
          item_list: [
            {
              type: 1,
              text_item: { text: "hello from pending update" },
            },
          ],
        },
      ],
    };
  }) as typeof ApiClient.prototype.getUpdates;

  WeChatClient.prototype.sendText = (async function mockSendText(
    to: string,
    text: string,
    contextToken?: string,
  ) {
    assert.equal(to, user.userId);
    assert.equal(text, "hello after refresh");
    assert.equal(contextToken, "ctx-from-refresh");
    return "client-id-refreshed";
  }) as typeof WeChatClient.prototype.sendText;

  try {
    await withApp(
      async (app, dataDir) => {
        const response = await app.inject({
          method: "POST",
          url: "/send",
          headers: {
            "x-api-key": user.apiKey,
          },
          payload: {
            text: "hello after refresh",
          },
        });

        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json(), {
          ok: true,
          clientId: "client-id-refreshed",
        });

        const safeUserId = user.userId.replace(/[^a-zA-Z0-9_@.-]/g, "_");
        const messagesPath = path.join(dataDir, "users", safeUserId, "messages.json");
        const syncBufPath = path.join(dataDir, "users", safeUserId, "sync-buf.json");

        const messages = JSON.parse(await fs.readFile(messagesPath, "utf-8")) as Array<{
          direction?: string;
          payload?: { context_token?: string };
        }>;
        const syncBuf = JSON.parse(await fs.readFile(syncBufPath, "utf-8")) as { buf?: string };

        assert.ok(
          messages.some(
            (entry) =>
              entry.direction === "inbound" &&
              entry.payload?.context_token === "ctx-from-refresh",
          ),
        );
        assert.equal(syncBuf.buf, "buf-after-refresh");
      },
      {
        setupDataDir: async (dataDir) => {
          await writeFixtureUser(dataDir, user);
        },
      },
    );
  } finally {
    ApiClient.prototype.getUpdates = originalGetUpdates;
    WeChatClient.prototype.sendText = originalSendText;
  }
});

test("service auto replies pong when inbound text is /ping", async () => {
  const user: UserRecord = {
    userId: "self-user@im.wechat",
    apiKey: "wk_test_auto_ping",
    createdAt: "2026-04-13T00:00:00.000Z",
    lastLoginAt: "2026-04-13T00:00:00.000Z",
    session: {
      accountId: "bot-im-bot",
      token: "bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      userId: "self-user@im.wechat",
      loginStatus: "confirmed",
      lastMessage: "Login successful!",
    },
  };

  const originalStart = WeChatClient.prototype.start;
  const originalSendText = WeChatClient.prototype.sendText;

  WeChatClient.prototype.start = (async function mockStart(this: WeChatClient) {
    this.emit("message", {
      message_id: 123456,
      from_user_id: user.userId,
      to_user_id: "bot@im.bot",
      context_token: "ctx-auto-ping",
      item_list: [
        {
          type: 1,
          text_item: { text: "/ping" },
        },
      ],
    });
  }) as typeof WeChatClient.prototype.start;

  WeChatClient.prototype.sendText = (async function mockSendText(
    to: string,
    text: string,
    contextToken?: string,
  ) {
    assert.equal(to, user.userId);
    assert.equal(text, "pong");
    assert.equal(contextToken, "ctx-auto-ping");
    return "client-id-pong";
  }) as typeof WeChatClient.prototype.sendText;

  try {
    await withApp(
      async (_app, dataDir) => {
        await new Promise((resolve) => setTimeout(resolve, 20));

        const safeUserId = user.userId.replace(/[^a-zA-Z0-9_@.-]/g, "_");
        const messagesPath = path.join(dataDir, "users", safeUserId, "messages.json");
        const messages = JSON.parse(await fs.readFile(messagesPath, "utf-8")) as Array<{
          direction?: string;
          payload?: { text?: string; trigger?: string };
          summary?: string;
        }>;

        assert.ok(
          messages.some(
            (entry) =>
              entry.direction === "inbound" &&
              entry.summary?.includes('text="/ping"'),
          ),
        );
        assert.ok(
          messages.some(
            (entry) =>
              entry.direction === "outbound" &&
              entry.payload?.text === "pong" &&
              entry.payload?.trigger === "/ping",
          ),
        );
      },
      {
        setupDataDir: async (dataDir) => {
          await writeFixtureUser(dataDir, user);
        },
        config: {
          autoStartMonitor: true,
        },
      },
    );
  } finally {
    WeChatClient.prototype.start = originalStart;
    WeChatClient.prototype.sendText = originalSendText;
  }
});
