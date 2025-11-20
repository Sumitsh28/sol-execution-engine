import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import dotenv from "dotenv";
import { connectDB } from "./config/database";
import { createOrder } from "./controllers/orderController";
import { redisSubscriber } from "./config/redis";

dotenv.config();

const server = Fastify({ logger: true });
const PORT = Number(process.env.PORT) || 3000;

const activeConnections = new Map<string, any>();

const startServer = async () => {
  await connectDB();

  await server.register(cors);
  await server.register(websocket);

  server.post("/orders", createOrder);

  server.get("/ws", { websocket: true }, (connection: any, req: any) => {
    const query = req.query as { orderId: string };
    const { orderId } = query;

    if (!orderId) {
      connection.socket.close(1008, "Order ID required");
      return;
    }

    console.log(`🔌 Client connected for Order: ${orderId}`);
    activeConnections.set(orderId, connection.socket);

    redisSubscriber.subscribe(`order-updates:${orderId}`);

    connection.socket.on("close", () => {
      console.log(`❌ Client disconnected: ${orderId}`);
      activeConnections.delete(orderId);
      redisSubscriber.unsubscribe(`order-updates:${orderId}`);
    });
  });

  redisSubscriber.on("message", (channel, message) => {
    const orderId = channel.split(":")[1];
    if (activeConnections.has(orderId)) {
      const socket = activeConnections.get(orderId);
      socket.send(message);
    }
  });

  try {
    await server.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

startServer();
