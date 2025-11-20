import { Queue } from "bullmq";
import dotenv from "dotenv";

dotenv.config();

const redisConfig = {
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT) || 6379,
};

export const tradeQueue = new Queue("trade-queue", {
  connection: redisConfig,
});

console.log("✅ Trade Queue Initialized");
