import Redis from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../observability/logger.js";

let _redis: Redis | null = null;

export const getRedis = (): Redis => {
    if (!_redis) {
        _redis = new Redis({
            host: env.REDIS_HOST,
            port: env.REDIS_PORT,
            maxRetriesPerRequest: 3,
            enableReadyCheck: true,
            lazyConnect: true,
        });

        _redis.on("connect", () =>
            logger.info("Redis connected"),
        );
        _redis.on("error", (err) =>
            logger.error({ component: "redis", err }, "Redis error"),
        );
        _redis.on("reconnecting", () =>
            logger.warn("Redis reconnecting"),
        );
    }

    return _redis;
};

export const closeRedis = async (): Promise<void> => {
    if (_redis) {
        await _redis.quit();
        _redis = null;
    }
};
