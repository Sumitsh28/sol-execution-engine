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
  await AppDataSource.initialize();
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
          message: "Scanning Meteora & Raydium...",
        });

        await new Promise((r) => setTimeout(r, 1000));

        order.status = "building";
        await publishUpdate(orderId, "building", {
          message: "Building transaction...",
        });

        const { txHash, price } = await dexHandler.executeSwap(
          orderId,
          order.amount
        );

        order.status = "confirmed";
        order.txHash = txHash;
        order.executedPrice = price;
        order.logs.push(`Swapped on Meteora at ${price}`);

        await orderRepository.save(order);
        await publishUpdate(orderId, "confirmed", {
          txHash,
          price,
          explorerUrl: `https://explorer.solana.com/tx/${txHash}?cluster=devnet`,
        });
      } catch (error: any) {
        console.error(`Order ${orderId} failed:`, error.message);

        order.status = "failed";
        order.error = error.message;
        await orderRepository.save(order);
        await publishUpdate(orderId, "failed", { error: error.message });
      }
    },
    { connection: redisConfig }
  );
};

startWorker();
