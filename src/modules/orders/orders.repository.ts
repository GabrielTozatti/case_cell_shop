import { getRedis } from "../../infra/redis.js";

export type OrderStatus = "pending" | "processing" | "completed" | "failed";

export interface Order {
    orderId: string;
    productId: string;
    quantity: number;
    status: OrderStatus;
    idempotencyKey: string;
    correlationId: string;
    createdAt: string;
    updatedAt: string;
    errorMessage?: string;
    erpOrderRef?: string;
}

const ORDER_TTL = 60 * 60 * 24 * 7;
const orderKey = (id: string) => `order:${id}`;
const idempotencyKey = (key: string) => `idempotency:${key}`;

let memoryStore: Map<string, Order> | null = null;
let memoryIdempotency: Map<string, string> | null = null;

export const ordersRepository = {
    useMemoryStore() {
        memoryStore = new Map();
        memoryIdempotency = new Map();
    },

    clear() {
        memoryStore?.clear();
        memoryIdempotency?.clear();
    },

    size(): number {
        return memoryStore?.size ?? 0;
    },

    async create(order: Order): Promise<Order> {
        if (memoryStore) {
            memoryStore.set(order.orderId, order);
            memoryIdempotency!.set(order.idempotencyKey, order.orderId);
            return order;
        }
        const redis = getRedis();
        await redis.set(
            orderKey(order.orderId),
            JSON.stringify(order),
            "EX",
            ORDER_TTL,
        );
        await redis.set(
            idempotencyKey(order.idempotencyKey),
            order.orderId,
            "EX",
            ORDER_TTL,
        );
        return order;
    },

    async findById(orderId: string): Promise<Order | null> {
        if (memoryStore) return memoryStore.get(orderId) ?? null;
        const redis = getRedis();
        const raw = await redis.get(orderKey(orderId));
        return raw ? (JSON.parse(raw) as Order) : null;
    },

    async findByIdempotencyKey(key: string): Promise<Order | null> {
        if (memoryStore) {
            const orderId = memoryIdempotency!.get(key);
            return orderId ? (memoryStore.get(orderId) ?? null) : null;
        }
        const redis = getRedis();
        const orderId = await redis.get(idempotencyKey(key));
        if (!orderId) return null;
        const raw = await redis.get(orderKey(orderId));
        return raw ? (JSON.parse(raw) as Order) : null;
    },

    async updateStatus(
        orderId: string,
        status: OrderStatus,
        errorMessage?: string,
        erpOrderRef?: string,
    ): Promise<Order | null> {
        if (memoryStore) {
            const order = memoryStore.get(orderId);
            if (!order) return null;
            order.status = status;
            order.updatedAt = new Date().toISOString();
            if (errorMessage) order.errorMessage = errorMessage;
            if (erpOrderRef) order.erpOrderRef = erpOrderRef;
            memoryStore.set(orderId, order);
            return order;
        }
        const redis = getRedis();
        const raw = await redis.get(orderKey(orderId));
        if (!raw) return null;
        const order = JSON.parse(raw) as Order;
        order.status = status;
        order.updatedAt = new Date().toISOString();
        if (errorMessage) order.errorMessage = errorMessage;
        if (erpOrderRef) order.erpOrderRef = erpOrderRef;
        await redis.set(
            orderKey(orderId),
            JSON.stringify(order),
            "EX",
            ORDER_TTL,
        );
        return order;
    },
};
