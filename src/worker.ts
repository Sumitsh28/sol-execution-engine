import { Worker } from "bullmq";
import { AppDataSource } from "./config/database";
import { Order } from "./entities/Order";
import { DexHandler } from "./lib/solana";
import { redisClient } from "./config/redis";
import client from "prom-client";
import dotenv from "dotenv";

dotenv.config();

const redisConfig = {
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT) || 6379,
};

// ---------------------------------------------------------
// 1. PROMETHEUS METRICS SETUP
// ---------------------------------------------------------
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const orderDuration = new client.Histogram({
  name: "order_processing_duration_seconds",
  help: "Duration of order processing in seconds",
  buckets: [0.5, 1, 2, 5, 10, 30], // Buckets for duration tracking
});
register.registerMetric(orderDuration);

// Helper to publish updates to WebSocket via Redis
const publishUpdate = async (
  orderId: string,
  status: string,
  data: any = {}
) => {
  const message = JSON.stringify({ orderId, status, ...data });
  await redisClient.publish(`order-updates:${orderId}`, message);
  console.log(`📡 Update sent for ${orderId}: ${status}`);
};

const startWorker = async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize();
  const orderRepository = AppDataSource.getRepository(Order);
  const dexHandler = new DexHandler();

  console.log("👷 Worker started! Listening for jobs...");

  const worker = new Worker(
    "trade-queue",
    async (job) => {
      const endTimer = orderDuration.startTimer(); // Start Prometheus timer
      const { orderId } = job.data;

      const order = await orderRepository.findOneBy({ id: orderId });

      if (!order) {
        console.warn(`⚠️ Order ${orderId} not found in DB`);
        return;
      }

      try {
        // STATUS: ROUTING
        order.status = "routing";
        await orderRepository.save(order);
        await publishUpdate(orderId, "routing", {
          message: `Scanning DEXs for best price...`,
        });

        // STATUS: BUILDING
        order.status = "building";
        await publishUpdate(orderId, "building", {
          message: "Building transaction...",
        });

        // EXECUTE SWAP (Now passing mints dynamically)
        // Note: amount is passed as a number (e.g., 0.1 SOL)
        const { txHash, price, dex } = await dexHandler.executeSwap(
          orderId,
          Number(order.amount),
          order.inputMint,
          order.outputMint
        );

        // STATUS: CONFIRMED
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

        console.log(`✅ SUCCESS! [${dex.toUpperCase()}] Tx: ${txHash}`);

        await orderRepository.save(order);
        await publishUpdate(orderId, "confirmed", {
          txHash,
          price,
          dex,
          explorerUrl,
        });
      } catch (error: any) {
        console.error(`❌ Order ${orderId} failed:`, error.message);

        order.status = "failed";
        order.error = error.message;
        await orderRepository.save(order);
        await publishUpdate(orderId, "failed", { error: error.message });

        throw error; // Triggers BullMQ retry logic
      } finally {
        endTimer(); // Stop Prometheus timer
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

  // Graceful Shutdown Logic
  process.on("SIGTERM", async () => {
    console.log("🛑 SIGTERM received. Closing worker...");
    await worker.close();
    await AppDataSource.destroy();
    process.exit(0);
  });
};

startWorker();
