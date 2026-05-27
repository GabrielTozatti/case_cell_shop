import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import {
    ordersRepository,
    type Order,
} from "../src/modules/orders/orders.repository.js";

const makeOrder = (overrides: Partial<Order> = {}): Order => {
    return {
        orderId: "ord-test-001",
        productId: "prod-001",
        quantity: 2,
        status: "pending",
        idempotencyKey: "idem-test-001",
        correlationId: "corr-test-001",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...overrides,
    };
};

describe("Orders Repository — Status Lifecycle", () => {
    beforeAll(() => {
        ordersRepository.useMemoryStore();
    });

    beforeEach(() => {
        ordersRepository.clear();
    });

    it("should create an order with status pending", async () => {
        const order = await ordersRepository.create(makeOrder());
        expect(order.status).toBe("pending");
        expect(await ordersRepository.findById("ord-test-001")).not.toBeNull();
    });

    it("should transition from pending → processing → completed", async () => {
        await ordersRepository.create(makeOrder());

        await ordersRepository.updateStatus("ord-test-001", "processing");
        expect((await ordersRepository.findById("ord-test-001"))?.status).toBe(
            "processing",
        );

        await ordersRepository.updateStatus(
            "ord-test-001",
            "completed",
            undefined,
            "ERP-99999",
        );
        const completed = await ordersRepository.findById("ord-test-001");
        expect(completed?.status).toBe("completed");
        expect(completed?.erpOrderRef).toBe("ERP-99999");
    });

    it("should transition to failed with errorMessage", async () => {
        await ordersRepository.create(makeOrder());
        await ordersRepository.updateStatus(
            "ord-test-001",
            "failed",
            "ERP_TIMEOUT: billing service did not respond",
        );

        const order = await ordersRepository.findById("ord-test-001");
        expect(order?.status).toBe("failed");
        expect(order?.errorMessage).toMatch(/ERP_TIMEOUT/);
    });

    it("should find order by idempotencyKey", async () => {
        await ordersRepository.create(
            makeOrder({ idempotencyKey: "idem-abc" }),
        );
        const found = await ordersRepository.findByIdempotencyKey("idem-abc");
        expect(found?.orderId).toBe("ord-test-001");
    });

    it("should return null for unknown orderId", async () => {
        expect(
            await ordersRepository.findById("ord-does-not-exist"),
        ).toBeNull();
    });

    it("should return null for unknown idempotencyKey", async () => {
        expect(
            await ordersRepository.findByIdempotencyKey("unknown-key"),
        ).toBeNull();
    });

    it("should update updatedAt timestamp on status change", async () => {
        await ordersRepository.create(makeOrder());
        const before = (await ordersRepository.findById("ord-test-001"))!
            .updatedAt;

        await new Promise((r) => setTimeout(r, 10));
        await ordersRepository.updateStatus("ord-test-001", "processing");

        const after = (await ordersRepository.findById("ord-test-001"))!
            .updatedAt;
        expect(new Date(after).getTime()).toBeGreaterThan(
            new Date(before).getTime(),
        );
    });

    it("should handle multiple orders independently", async () => {
        await ordersRepository.create(
            makeOrder({ orderId: "ord-A", idempotencyKey: "key-A" }),
        );
        await ordersRepository.create(
            makeOrder({ orderId: "ord-B", idempotencyKey: "key-B" }),
        );

        await ordersRepository.updateStatus("ord-A", "completed");
        await ordersRepository.updateStatus("ord-B", "failed", "Error");

        expect((await ordersRepository.findById("ord-A"))?.status).toBe(
            "completed",
        );
        expect((await ordersRepository.findById("ord-B"))?.status).toBe(
            "failed",
        );
        expect(ordersRepository.size()).toBe(2);
    });
});
