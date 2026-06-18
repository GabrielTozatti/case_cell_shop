const safeParseInt = (raw: string | undefined, fallback: number): number => {
    const parsed = parseInt(raw ?? String(fallback), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
};

export const env = {
    PORT: safeParseInt(process.env.PORT, 3000),
    NODE_ENV: process.env.NODE_ENV ?? "development",

    REDIS_HOST: process.env.REDIS_HOST ?? "localhost",
    REDIS_PORT: safeParseInt(process.env.REDIS_PORT, 6379),

    PRODUCT_CACHE_TTL: safeParseInt(process.env.PRODUCT_CACHE_TTL, 60),

    ERP_PROCESSING_DELAY_MS: safeParseInt(process.env.ERP_PROCESSING_DELAY_MS, 3000),

    CHECKOUT_QUEUE_NAME: process.env.CHECKOUT_QUEUE_NAME ?? "checkout",

    LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
} as const;
