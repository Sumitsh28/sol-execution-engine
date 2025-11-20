import { DataSource } from "typeorm";
import { Order } from "../entities/Order";
import dotenv from "dotenv";

dotenv.config();

export const AppDataSource = new DataSource({
  type: "postgres",
  url: process.env.DATABASE_URL,
  synchronize: true,
  logging: false,
  entities: [Order],
  subscribers: [],
  migrations: [],
});

export const connectDB = async () => {
  try {
    await AppDataSource.initialize();
    console.log("✅ PostgreSQL Connected");
  } catch (error) {
    console.error("❌ Database connection failed:", error);
    process.exit(1);
  }
};
