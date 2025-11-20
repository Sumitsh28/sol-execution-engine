import { Worker } from "bullmq";
import { AppDataSource } from "./config/database";
import { Order } from "./entities/Order";
import { DexHandler } from "./lib/solana";
import { redisClient } from "./config/redis";
import client from "prom-client";
import dotenv from "dotenv";
import Fastify from "fastify";

dotenv.config();

const redisConfig = {
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT) || 6379,
};

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const orderDuration = new client.Histogram({
  name: "order_processing_duration_seconds",
  help: "Duration of order processing in seconds",
  buckets: [0.5, 1, 2, 5, 10, 30],
});
register.registerMetric(orderDuration);

const publishUpdate = async (
  orderId: string,
  status: string,
  data: any = {}
) => {
  const message = JSON.stringify({ orderId, status, ...data });
  await redisClient.publish(`order-updates:${orderId}`, message);
  console.log(`Update sent for ${orderId}: ${status}`);
};

const startWorker = async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize();
  const orderRepository = AppDataSource.getRepository(Order);
  const dexHandler = new DexHandler();

  console.log("Worker started! Listening for jobs...");

  const worker = new Worker(
    "trade-queue",
    async (job) => {
      const endTimer = orderDuration.startTimer();
      const { orderId } = job.data;

      const order = await orderRepository.findOneBy({ id: orderId });

      if (!order) {
        console.warn(`Order ${orderId} not found in DB`);
        return;
      }

      try {
        order.status = "routing";
        await orderRepository.save(order);
        await publishUpdate(orderId, "routing", {
          message: `Scanning DEXs for best price...`,
        });

        order.status = "building";
        await publishUpdate(orderId, "building", {
          message: "Building transaction...",
        });

        const { txHash, price, dex } = await dexHandler.executeSwap(
          orderId,
          Number(order.amount),
          order.inputMint,
          order.outputMint
        );

        order.status = "confirmed";
        order.txHash = txHash;
        order.executedPrice = price;
        order.logs.push(
          `Routed via ${dex.toUpperCase()} at ${price.toFixed(6)}`
        );

        const explorerUrl =
          dex === "mock-engine"
            ? "https://explorer.solana.com/?cluster=devnet"
            : `https://explorer.solana.com/tx/${txHash}?cluster=devnet`;

        console.log(`SUCCESS! [${dex.toUpperCase()}] Tx: ${txHash}`);

        await orderRepository.save(order);
        await publishUpdate(orderId, "confirmed", {
          txHash,
          price,
          dex,
          explorerUrl,
        });
      } catch (error: any) {
        console.error(`Order ${orderId} failed:`, error.message);

        order.status = "failed";
        order.error = error.message;
        await orderRepository.save(order);
        await publishUpdate(orderId, "failed", { error: error.message });

        throw error;
      } finally {
        endTimer();
      }
    },
    {
      connection: redisConfig,
      concurrency: 10,
      limiter: {
        max: 100,
        duration: 60000,
      },
    }
  );

  const metricsServer = Fastify();

  metricsServer.get("/metrics", async (req, reply) => {
    reply.header("Content-Type", register.contentType);
    return register.metrics();
  });

  try {
    const METRICS_PORT = Number(process.env.WORKER_METRICS_PORT) || 3001;
    await metricsServer.listen({ port: METRICS_PORT, host: "0.0.0.0" });
    console.log(
      `Worker Metrics running on http://0.0.0.0:${METRICS_PORT}/metrics`
    );
  } catch (err) {
    console.error("Failed to start worker metrics server", err);
  }

  process.on("SIGTERM", async () => {
    console.log("SIGTERM received. Closing worker...");
    await worker.close();
    await metricsServer.close();
    await AppDataSource.destroy();
    process.exit(0);
  });
};

startWorker();
