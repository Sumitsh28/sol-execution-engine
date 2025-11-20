import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from "typeorm";

export type OrderStatus =
  | "pending"
  | "routing"
  | "building"
  | "submitted"
  | "confirmed"
  | "failed";

@Entity()
export class Order {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  inputMint!: string; // The token user sells

  @Column()
  outputMint!: string; // The token user buys

  @Column("decimal", { precision: 20, scale: 9 })
  amount!: number; // Amount to swap

  @Column({
    type: "enum",
    enum: [
      "pending",
      "routing",
      "building",
      "submitted",
      "confirmed",
      "failed",
    ],
    default: "pending",
  })
  status!: OrderStatus;

  @Column({ nullable: true })
  txHash?: string; // Stores the real Solana transaction signature

  @Column({ type: "decimal", nullable: true })
  executedPrice?: number;

  @Column("text", { nullable: true })
  error?: string;

  @Column("jsonb", { default: [] })
  logs!: string[];

  @CreateDateColumn()
  createdAt!: Date;
}
