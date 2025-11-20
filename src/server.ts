import Fastify, { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import client from "prom-client"; // Prometheus Client
import dotenv from "dotenv";
import { connectDB, AppDataSource } from "./config/database";
import { createOrder } from "./controllers/orderController";
import { redisSubscriber, redisClient } from "./config/redis";

dotenv.config();

const server: FastifyInstance = Fastify({ logger: true });
const PORT = Number(process.env.PORT) || 3000;

// Track active WS connections for cleanup
const activeConnections = new Map<string, any>();

// ---------------------------------------------------------
// 1. PROMETHEUS METRICS SETUP (API Layer)
// ---------------------------------------------------------
const register = new client.Registry();
client.collectDefaultMetrics({ register });

// Metric: Track HTTP request duration
const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.1, 0.5, 1, 2, 5],
});
register.registerMetric(httpRequestDuration);

// Hook to measure request time
server.addHook("onRequest", (request, reply, done) => {
  (request as any).startTime = process.hrtime();
  done();
});

server.addHook("onResponse", (request, reply, done) => {
  const startTime = (request as any).startTime;
  if (startTime) {
    const diff = process.hrtime(startTime);
    const seconds = diff[0] + diff[1] / 1e9;
    httpRequestDuration
      .labels(
        request.method,
        request.routeOptions.url || "unknown",
        String(reply.statusCode)
      )
      .observe(seconds);
  }
  done();
});

// ---------------------------------------------------------
// 2. SERVER STARTUP & ROUTES
// ---------------------------------------------------------
const startServer = async () => {
  await connectDB();

  await server.register(cors);
  await server.register(websocket);

  // ✅ METRICS ROUTE
  server.get("/metrics", async (req, reply) => {
    reply.header("Content-Type", register.contentType);
    return register.metrics();
  });

  // ✅ ORDER SUBMISSION (Controller)
  server.post("/orders", createOrder);

  // ✅ WEBSOCKET UPGRADE
  server.get("/ws", { websocket: true }, (connection: any, req: any) => {
    const query = req.query as { orderId: string };
    const { orderId } = query;

    if (!orderId) {
      connection.socket.close(1008, "Order ID required");
      return;
    }

    console.log(`🔌 Client connected for Order: ${orderId}`);
    activeConnections.set(orderId, connection.socket);

    // Subscribe to Redis updates for this order
    redisSubscriber.subscribe(`order-updates:${orderId}`);

    connection.socket.on("close", () => {
      console.log(`❌ Client disconnected: ${orderId}`);
      activeConnections.delete(orderId);
      redisSubscriber.unsubscribe(`order-updates:${orderId}`);
    });
  });

  // Redis Listener to forward messages to WebSocket
  redisSubscriber.on("message", (channel, message) => {
    const orderId = channel.split(":")[1];
    if (activeConnections.has(orderId)) {
      const socket = activeConnections.get(orderId);
      if (socket.readyState === 1) {
        // 1 = OPEN
        socket.send(message);
      }
    }
  });

  try {
    await server.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 Metrics available at http://localhost:${PORT}/metrics`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

// ---------------------------------------------------------
// 3. GRACEFUL SHUTDOWN
// ---------------------------------------------------------
const closeGracefully = async (signal: string) => {
  console.log(`\n🛑 Received ${signal}. Closing resources...`);

  // 1. Stop accepting new requests
  await server.close();

  // 2. Close active WebSocket connections
  for (const [id, socket] of activeConnections) {
    socket.close(1001, "Server shutting down");
  }

  // 3. Close Database & Redis
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  await redisSubscriber.quit();
  await redisClient.quit();

  console.log("✅ Cleanup complete. Exiting.");
  process.exit(0);
};

process.on("SIGINT", () => closeGracefully("SIGINT"));
process.on("SIGTERM", () => closeGracefully("SIGTERM"));

startServer();
