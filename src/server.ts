import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./observability/logger.js";
import { getRedis, closeRedis } from "./infra/redis.js";
import { closeQueue } from "./infra/queue.js";

const start = async () => {
    const redis = getRedis();
    await redis.connect();

    const app = createApp();

    const server = app.listen(env.PORT, () => {
        logger.info(`CaseCellShop backend running on port ${env.PORT}`);
        logger.info("Start the worker separately: npm run worker");
    });

    const shutdown = async (signal: string) => {
        logger.info({ signal }, "Shutdown signal received");
        server.close(async () => {
            await closeQueue();
            await closeRedis();
            logger.info("Server closed cleanly");
            process.exit(0);
        });
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
};

start().catch((err) => {
    logger.error({ err }, "Failed to start server");
    process.exit(1);
});
