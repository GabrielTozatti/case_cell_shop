import { Router, type Request, type Response } from "express";
import { productsService } from "./products.service.js";
import { getRedis } from "../../infra/redis.js";

export const productsRouter = Router();

productsRouter.get("/", async (req: Request, res: Response) => {
    const { correlationId } = res.locals;

    try {
        const redis = getRedis();
        const wasCached = !!(await redis.get("catalog:all"));

        const products = await productsService.getAll(correlationId);

        const productsWithLiveStock = await Promise.all(
            products.map(async (product) => {
                const redisStock = await redis.get(`stock:${product.id}`);
                return {
                    ...product,
                    stock:
                        redisStock !== null
                            ? Math.max(0, parseInt(redisStock, 10))
                            : product.stock,
                };
            }),
        );

        res.setHeader("X-Cache", wasCached ? "HIT" : "MISS");
        res.setHeader("Cache-Control", "public, max-age=60");

        res.status(200).json({
            data: productsWithLiveStock,
            meta: {
                count: productsWithLiveStock.length,
                cachedResponse: wasCached,
                correlationId,
            },
        });
    } catch (err) {
        res.status(503).json({
            error: "SERVICE_UNAVAILABLE",
            message: "Could not fetch product catalog",
            correlationId,
        });
    }
});
