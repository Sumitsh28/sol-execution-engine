import Redis from "ioredis";
import dotenv from "dotenv";

dotenv.config();

const redisConfig = {
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT) || 6379,
};

export const redisClient = new Redis(redisConfig);

export const redisSubscriber = new Redis(redisConfig);

console.log("Redis Clients Initialized");
