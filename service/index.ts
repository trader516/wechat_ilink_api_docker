import { createApiServer } from "./app.js";
import { resolveConfig } from "./config.js";

async function main(): Promise<void> {
  const config = resolveConfig();
  const app = await createApiServer({ config });

  const shutdown = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  try {
    await app.listen({
      host: config.host,
      port: config.port,
    });

    console.log(
      `API server listening on http://${config.host}:${config.port}`,
    );
    console.log(`Swagger UI: http://${config.host}:${config.port}/docs`);
    console.log(`Data directory: ${config.dataDir}`);
  } catch (error) {
    console.error("Failed to start API server:", error);
    process.exit(1);
  }
}

void main();
