import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import {
    ordersRepository,
    type Order,
} from "../src/modules/orders/orders.repository.js";
import { metrics } from "../src/observability/metrics.js";

const simulateWorker = async (
    orderId: string,
    productId: string,
    quantity: number,
    correlationId: string,
    erpDelayMs = 0,
    forceFailure = false,
) => {
    metrics.checkoutStarted();
    await ordersRepository.updateStatus(orderId, "processing");

    if (erpDelayMs > 0) await new Promise((r) => setTimeout(r, erpDelayMs));

    if (forceFailure) {
        await ordersRepository.updateStatus(
            orderId,
            "failed",
            "ERP_TIMEOUT: billing service did not respond in time",
        );
        metrics.checkoutFailed();
        return { success: false };
    }

    const erpOrderRef = `ERP-${Date.now()}`;
    await ordersRepository.updateStatus(
        orderId,
        "completed",
        undefined,
        erpOrderRef,
    );
    metrics.checkoutCompleted();
    return { success: true, erpOrderRef };
};

const makeOrder = (overrides: Partial<Order> = {}): Order => {
    return {
        orderId: "ord-worker-001",
        productId: "prod-001",
        quantity: 1,
        status: "pending",
        idempotencyKey: "idem-worker-001",
        correlationId: "corr-worker-001",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...overrides,
    };
};

describe("Worker — Full Order Lifecycle", () => {
    beforeAll(() => {
        ordersRepository.useMemoryStore();
    });

    beforeEach(() => {
        ordersRepository.clear();
        metrics.reset();
    });

    it("should transition order from pending → processing → completed", async () => {
        await ordersRepository.create(makeOrder());

        expect(
            (await ordersRepository.findById("ord-worker-001"))?.status,
        ).toBe("pending");

        const result = await simulateWorker(
            "ord-worker-001",
            "prod-001",
            1,
            "corr-worker-001",
        );

        expect(result.success).toBe(true);
        const order = await ordersRepository.findById("ord-worker-001");
        expect(order?.status).toBe("completed");
        expect(order?.erpOrderRef).toMatch(/^ERP-\d+$/);

        const snap = metrics.snapshot();
        expect(snap.checkout.completed).toBe(1);
        expect(snap.checkout.failed).toBe(0);
        expect(snap.queue.active).toBe(0);
    });

    it("should transition order from pending → processing → failed on ERP error", async () => {
        await ordersRepository.create(makeOrder());

        const result = await simulateWorker(
            "ord-worker-001",
            "prod-001",
            1,
            "corr-worker-001",
            0,
            true,
        );

        expect(result.success).toBe(false);
        const order = await ordersRepository.findById("ord-worker-001");
        expect(order?.status).toBe("failed");
        expect(order?.errorMessage).toMatch(/ERP_TIMEOUT/);

        const snap = metrics.snapshot();
        expect(snap.checkout.failed).toBe(1);
        expect(snap.checkout.completed).toBe(0);
    });

    it("should set status to processing before completing", async () => {
        await ordersRepository.create(makeOrder());
        const statuses: string[] = [];

        const original = ordersRepository.updateStatus.bind(ordersRepository);
        vi.spyOn(ordersRepository, "updateStatus").mockImplementation(
            async (id, status, ...rest) => {
                statuses.push(status);
                return original(id, status, ...rest);
            },
        );

        await simulateWorker(
            "ord-worker-001",
            "prod-001",
            1,
            "corr-worker-001",
        );

        expect(statuses).toEqual(["processing", "completed"]);
    });

    it("should carry correlationId through the full lifecycle", async () => {
        const correlationId = "trace-abc-123";
        await ordersRepository.create(makeOrder({ correlationId }));

        await simulateWorker("ord-worker-001", "prod-001", 1, correlationId);

        const order = await ordersRepository.findById("ord-worker-001");
        expect(order?.correlationId).toBe(correlationId);
    });

    it("should process multiple orders independently", async () => {
        await ordersRepository.create(
            makeOrder({ orderId: "ord-A", idempotencyKey: "key-A" }),
        );
        await ordersRepository.create(
            makeOrder({ orderId: "ord-B", idempotencyKey: "key-B" }),
        );

        await Promise.all([
            simulateWorker("ord-A", "prod-001", 1, "corr-A"),
            simulateWorker("ord-B", "prod-001", 1, "corr-B", 0, true),
        ]);

        expect((await ordersRepository.findById("ord-A"))?.status).toBe(
            "completed",
        );
        expect((await ordersRepository.findById("ord-B"))?.status).toBe(
            "failed",
        );

        const snap = metrics.snapshot();
        expect(snap.checkout.completed).toBe(1);
        expect(snap.checkout.failed).toBe(1);
    });

    it("should update metrics queue counters correctly", async () => {
        await ordersRepository.create(makeOrder());

        metrics.checkoutEnqueued();
        expect(metrics.snapshot().queue.waiting).toBe(1);

        await simulateWorker(
            "ord-worker-001",
            "prod-001",
            1,
            "corr-worker-001",
        );

        const snap = metrics.snapshot();
        expect(snap.queue.waiting).toBe(0);
        expect(snap.queue.active).toBe(0);
        expect(snap.checkout.completed).toBe(1);
    });
});
