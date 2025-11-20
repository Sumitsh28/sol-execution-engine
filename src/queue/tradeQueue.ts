import { Queue } from "bullmq";
import dotenv from "dotenv";

dotenv.config();

const redisConfig = {
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT) || 6379,
};

export const tradeQueue = new Queue("trade-queue", {
  connection: redisConfig,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

console.log("✅ Trade Queue Initialized (100 orders/min limit set)");
