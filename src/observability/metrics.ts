interface CacheMetrics {
    hit: number;
    miss: number;
}

interface CheckoutMetrics {
    enqueued: number;
    completed: number;
    failed: number;
    oversellBlocked: number;
}

interface QueueMetrics {
    waiting: number;
    active: number;
}

const state = {
    cache: { hit: 0, miss: 0 } as CacheMetrics,
    checkout: {
        enqueued: 0,
        completed: 0,
        failed: 0,
        oversellBlocked: 0,
    } as CheckoutMetrics,
    queue: { waiting: 0, active: 0 } as QueueMetrics,
    startedAt: new Date().toISOString(),
};

export const metrics = {
    cacheHit() {
        state.cache.hit++;
    },
    cacheMiss() {
        state.cache.miss++;
    },

    checkoutEnqueued() {
        state.checkout.enqueued++;
        state.queue.waiting++;
    },
    checkoutStarted() {
        state.queue.waiting = Math.max(0, state.queue.waiting - 1);
        state.queue.active++;
    },
    checkoutCompleted() {
        state.queue.active = Math.max(0, state.queue.active - 1);
        state.checkout.completed++;
    },
    checkoutFailed() {
        state.queue.active = Math.max(0, state.queue.active - 1);
        state.checkout.failed++;
    },
    oversellBlocked() {
        state.checkout.oversellBlocked++;
    },

    snapshot() {
        const cacheTotal = state.cache.hit + state.cache.miss;
        return {
            ...state,
            cache: {
                ...state.cache,
                hitRate:
                    cacheTotal > 0
                        ? `${((state.cache.hit / cacheTotal) * 100).toFixed(1)}%`
                        : "n/a",
            },
            uptimeSeconds: Math.floor(
                (Date.now() - new Date(state.startedAt).getTime()) / 1000,
            ),
        };
    },

    reset() {
        state.cache = { hit: 0, miss: 0 };
        state.checkout = {
            enqueued: 0,
            completed: 0,
            failed: 0,
            oversellBlocked: 0,
        };
        state.queue = { waiting: 0, active: 0 };
        state.startedAt = new Date().toISOString();
    },
};
