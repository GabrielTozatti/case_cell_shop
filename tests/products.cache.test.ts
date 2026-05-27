import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { metrics } from "../src/observability/metrics.js";

const redisStore = new Map<string, { value: string; expiresAt?: number }>();

const mockRedis = {
    get: async (key: string) => {
        const entry = redisStore.get(key);
        if (!entry) return null;
        if (entry.expiresAt && Date.now() > entry.expiresAt) {
            redisStore.delete(key);
            return null;
        }
        return entry.value;
    },
    set: async (
        key: string,
        value: string,
        _ex?: string,
        ttl?: number,
        nx?: string,
    ) => {
        if (nx === "NX" && redisStore.has(key)) return null;
        redisStore.set(key, {
            value,
            expiresAt: ttl ? Date.now() + ttl * 1000 : undefined,
        });
        return "OK";
    },
    del: async (key: string) => {
        redisStore.delete(key);
        return 1;
    },
};

vi.mock("../src/infra/redis.js", () => ({
    getRedis: () => mockRedis,
    closeRedis: vi.fn(),
}));

const mockErpCall = vi.fn().mockResolvedValue([
    { id: "prod-001", name: "Capinha iPhone 15", price: 4990, stock: 150 },
    { id: "prod-002", name: "Capinha Samsung S24", price: 6990, stock: 75 },
]);

vi.mock("../src/modules/products/products.repository.js", () => ({
    productsRepository: { findAll: mockErpCall },
}));

const { productsService } =
    await import("../src/modules/products/products.service.js");

describe("Products Cache — Cache-Aside Strategy", () => {
    beforeEach(() => {
        redisStore.clear();
        metrics.reset();
        mockErpCall.mockClear();
    });

    it("should call ERP on first request (cache MISS) and populate cache", async () => {
        const products = await productsService.getAll("corr-001");

        expect(products).toHaveLength(2);
        expect(mockErpCall).toHaveBeenCalledTimes(1);

        const snapshot = metrics.snapshot();
        expect(snapshot.cache.miss).toBe(1);
        expect(snapshot.cache.hit).toBe(0);

        expect(redisStore.has("catalog:all")).toBe(true);
    });

    it("should return cached data on second request (cache HIT) without calling ERP", async () => {
        await productsService.getAll("corr-001");
        mockErpCall.mockClear();
        metrics.reset();

        const products = await productsService.getAll("corr-002");

        expect(products).toHaveLength(2);
        expect(mockErpCall).not.toHaveBeenCalled();

        const snapshot = metrics.snapshot();
        expect(snapshot.cache.hit).toBe(1);
        expect(snapshot.cache.miss).toBe(0);
        expect(snapshot.cache.hitRate).toBe("100.0%");
    });

    it("should call ERP again after cache invalidation", async () => {
        await productsService.getAll("corr-001");

        await productsService.invalidateCache();
        mockErpCall.mockClear();
        metrics.reset();

        await productsService.getAll("corr-003");

        expect(mockErpCall).toHaveBeenCalledTimes(1);
        expect(metrics.snapshot().cache.miss).toBe(1);
    });

    it("should handle simulated cache TTL expiry (cache MISS after expiry)", async () => {
        redisStore.set("catalog:all", {
            value: JSON.stringify([{ id: "prod-stale", name: "Old Product" }]),
            expiresAt: Date.now() - 1,
        });

        await productsService.getAll("corr-004");

        expect(mockErpCall).toHaveBeenCalledTimes(1);
        expect(metrics.snapshot().cache.miss).toBe(1);
    });

    it("should track hit rate correctly across mixed requests", async () => {
        await productsService.getAll("corr-001");
        await productsService.getAll("corr-002");
        await productsService.getAll("corr-003");

        const snapshot = metrics.snapshot();
        expect(snapshot.cache.miss).toBe(1);
        expect(snapshot.cache.hit).toBe(2);
        expect(snapshot.cache.hitRate).toBe("66.7%");
    });
});
