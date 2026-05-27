import { getRedis } from "../../infra/redis.js";
import { metrics } from "../../observability/metrics.js";
import { createRequestLogger } from "../../observability/logger.js";
import { productsRepository, type Product } from "./products.repository.js";
import { env } from "../../config/env.js";

const CACHE_KEY = "catalog:all";

export const productsService = {
    async getAll(correlationId: string): Promise<Product[]> {
        const log = createRequestLogger(correlationId);
        const redis = getRedis();

        const spanId = `span-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const cached = await redis.get(CACHE_KEY);

        if (cached) {
            metrics.cacheHit();
            log.info(
                {
                    spanId,
                    component: "products-service",
                    cacheKey: CACHE_KEY,
                    result: "HIT",
                },
                "Cache HIT — returning cached catalog",
            );
            return JSON.parse(cached) as Product[];
        }

        metrics.cacheMiss();
        log.info(
            {
                spanId,
                component: "products-service",
                cacheKey: CACHE_KEY,
                result: "MISS",
            },
            "Cache MISS — fetching from ERP repository",
        );

        const products = await productsRepository.findAll();

        try {
            await redis.set(
                CACHE_KEY,
                JSON.stringify(products),
                "EX",
                env.PRODUCT_CACHE_TTL,
            );
            log.info(
                {
                    spanId,
                    component: "products-service",
                    ttl: env.PRODUCT_CACHE_TTL,
                },
                "Cache populated",
            );
        } catch (err) {
            log.warn(
                { spanId, component: "products-service", err },
                "Failed to populate cache — serving uncached response",
            );
        }

        return products;
    },

    async invalidateCache(): Promise<void> {
        const redis = getRedis();
        await redis.del(CACHE_KEY);
    },
};
