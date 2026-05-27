import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { ordersRepository } from "../src/modules/orders/orders.repository.js";
import { metrics } from "../src/observability/metrics.js";

const atomicStock: Record<string, number> = {};
const redisStore = new Map<string, string>();

vi.mock("../src/infra/redis.js", () => ({
    getRedis: () => ({
        get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
        set: vi.fn(
            async (
                key: string,
                value: string | number,
                _ex?: string,
                _ttl?: number,
                nx?: string,
            ) => {
                if (nx === "NX") {
                    if (redisStore.has(key)) return null;
                    atomicStock[key] = Number(value);
                }
                redisStore.set(key, String(value));
                return "OK";
            },
        ),
        del: vi.fn(async (key: string) => {
            redisStore.delete(key);
            return 1;
        }),
        decrby: vi.fn(async (key: string, amount: number) => {
            if (atomicStock[key] === undefined) {
                atomicStock[key] = parseInt(redisStore.get(key) ?? "0");
            }
            atomicStock[key] -= amount;
            return atomicStock[key];
        }),
        incrby: vi.fn(async (key: string, amount: number) => {
            atomicStock[key] = (atomicStock[key] ?? 0) + amount;
            return atomicStock[key];
        }),
    }),
    closeRedis: vi.fn(),
}));

vi.mock("../src/infra/queue.js", () => ({
    getCheckoutQueue: () => ({
        add: vi.fn().mockResolvedValue({ id: "job-mock" }),
    }),
    closeQueue: vi.fn(),
}));

vi.mock("../src/modules/products/products.repository.js", () => ({
    productsRepository: {
        findById: vi.fn(async (id: string) => {
            if (id === "prod-001")
                return {
                    id: "prod-001",
                    name: "Capinha iPhone 15",
                    price: 4990,
                    stock: 5,
                };
            if (id === "prod-low")
                return {
                    id: "prod-low",
                    name: "Produto Escasso",
                    price: 9990,
                    stock: 1,
                };
            return null;
        }),
    },
}));

const { checkoutService } =
    await import("../src/modules/checkout/checkout.service.js");

describe("Checkout — Atomic Stock Reservation (Oversell Prevention)", () => {
    beforeAll(() => {
        ordersRepository.useMemoryStore();
    });

    beforeEach(() => {
        ordersRepository.clear();
        metrics.reset();
        for (const key of Object.keys(atomicStock)) delete atomicStock[key];
        redisStore.clear();
    });

    it("should allow exactly N purchases when stock = N with concurrent requests", async () => {
        const STOCK = 5;
        const CONCURRENT = 10;

        const results = await Promise.all(
            Array.from({ length: CONCURRENT }, (_, i) =>
                checkoutService.initiateCheckout(
                    {
                        productId: "prod-001",
                        quantity: 1,
                        idempotencyKey: `key-${i}`,
                    },
                    `corr-${i}`,
                ),
            ),
        );

        const succeeded = results.filter((r) => r.success);
        const failed = results.filter(
            (r) =>
                !r.success &&
                "reason" in r &&
                r.reason === "INSUFFICIENT_STOCK",
        );

        expect(succeeded).toHaveLength(STOCK);
        expect(failed).toHaveLength(CONCURRENT - STOCK);

        const snap = metrics.snapshot();
        expect(snap.checkout.oversellBlocked).toBe(CONCURRENT - STOCK);
        expect(snap.checkout.enqueued).toBe(STOCK);
    });

    it("should block oversell even when requested quantity > 1", async () => {
        const result = await checkoutService.initiateCheckout(
            {
                productId: "prod-001",
                quantity: 6,
                idempotencyKey: "key-overqty",
            },
            "corr-test",
        );

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.reason).toBe("INSUFFICIENT_STOCK");
        }
        expect(metrics.snapshot().checkout.oversellBlocked).toBe(1);
    });

    it("should return the same order for duplicate idempotency keys (no double charge)", async () => {
        const input = {
            productId: "prod-001",
            quantity: 1,
            idempotencyKey: "idem-key-001",
        };

        const first = await checkoutService.initiateCheckout(input, "corr-1");
        const second = await checkoutService.initiateCheckout(input, "corr-2");
        const third = await checkoutService.initiateCheckout(input, "corr-3");

        expect(first.success).toBe(true);
        expect(second.success).toBe(true);
        expect(third.success).toBe(true);

        if (first.success && second.success && third.success) {
            expect(second.order.orderId).toBe(first.order.orderId);
            expect(third.order.orderId).toBe(first.order.orderId);
            expect(second.idempotent).toBe(true);
            expect(third.idempotent).toBe(true);
        }

        expect(ordersRepository.size()).toBe(1);
        expect(metrics.snapshot().checkout.enqueued).toBe(1);
    });

    it("should return PRODUCT_NOT_FOUND for unknown productId", async () => {
        const result = await checkoutService.initiateCheckout(
            {
                productId: "prod-unknown",
                quantity: 1,
                idempotencyKey: "key-unknown",
            },
            "corr-unknown",
        );

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.reason).toBe("PRODUCT_NOT_FOUND");
        }
    });

    it("should reject quantity less than 1", async () => {
        const result = await checkoutService.initiateCheckout(
            { productId: "prod-001", quantity: 0, idempotencyKey: "key-zero" },
            "corr-zero",
        );

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.reason).toBe("INVALID_QUANTITY");
        }
    });

    it("should reject non-integer quantity", async () => {
        const result = await checkoutService.initiateCheckout(
            {
                productId: "prod-001",
                quantity: 1.5,
                idempotencyKey: "key-float",
            },
            "corr-float",
        );

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.reason).toBe("INVALID_QUANTITY");
        }
    });

    it("sequential purchases should deplete stock correctly", async () => {
        for (let i = 0; i < 5; i++) {
            const result = await checkoutService.initiateCheckout(
                {
                    productId: "prod-001",
                    quantity: 1,
                    idempotencyKey: `seq-${i}`,
                },
                `corr-seq-${i}`,
            );
            expect(result.success).toBe(true);
        }

        const sixth = await checkoutService.initiateCheckout(
            { productId: "prod-001", quantity: 1, idempotencyKey: "seq-5" },
            "corr-seq-5",
        );
        expect(sixth.success).toBe(false);
        if (!sixth.success) expect(sixth.reason).toBe("INSUFFICIENT_STOCK");
    });
});
