import { Worker } from "bullmq";
import { AppDataSource } from "./config/database";
import { Order } from "./entities/Order";
import { DexHandler } from "./lib/solana";
import { redisClient } from "./config/redis";
import dotenv from "dotenv";

dotenv.config();

const redisConfig = {
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT) || 6379,
};

const publishUpdate = async (
  orderId: string,
  status: string,
  data: any = {}
) => {
  const message = JSON.stringify({ orderId, status, ...data });
  await redisClient.publish(`order-updates:${orderId}`, message);
  console.log(`Update sent: ${status}`);
};

const startWorker = async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize();
  const orderRepository = AppDataSource.getRepository(Order);
  const dexHandler = new DexHandler();

  console.log("Worker started! Listening for jobs...");

  const worker = new Worker(
    "trade-queue",
    async (job) => {
      const { orderId } = job.data;
      const order = await orderRepository.findOneBy({ id: orderId });

      if (!order) return;

      try {
        order.status = "routing";
        await orderRepository.save(order);
        await publishUpdate(orderId, "routing", {
          message: "Scanning DEXs...",
        });

        order.status = "building";
        await publishUpdate(orderId, "building", {
          message: "Executing Strategy...",
        });

        const { txHash, price, dex } = await dexHandler.executeSwap(
          orderId,
          order.amount
        );

        order.status = "confirmed";
        order.txHash = txHash;
        order.executedPrice = price;
        order.logs.push(
          `Routed via ${dex.toUpperCase()} at ${price.toFixed(4)} USDC`
        );

        const explorerUrl =
          dex === "mock-engine"
            ? "https://explorer.solana.com/?cluster=devnet"
            : `https://explorer.solana.com/tx/${txHash}?cluster=devnet`;

        console.log(`SUCCESS! [${dex.toUpperCase()}] Link: ${explorerUrl}`);

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
};

startWorker();
