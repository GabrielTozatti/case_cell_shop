export const env = {
    PORT: parseInt(process.env.PORT ?? "3000", 10),
    NODE_ENV: process.env.NODE_ENV ?? "development",

    REDIS_HOST: process.env.REDIS_HOST ?? "localhost",
    REDIS_PORT: parseInt(process.env.REDIS_PORT ?? "6379", 10),

    PRODUCT_CACHE_TTL: parseInt(process.env.PRODUCT_CACHE_TTL ?? "60", 10),

    ERP_PROCESSING_DELAY_MS: parseInt(process.env.ERP_PROCESSING_DELAY_MS ?? "3000", 10),

    CHECKOUT_QUEUE_NAME: process.env.CHECKOUT_QUEUE_NAME ?? "checkout",

    LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
} as const;
