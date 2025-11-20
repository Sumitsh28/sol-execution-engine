import { AppDataSource } from "./config/database";
import { Order } from "./entities/Order";
import { redisClient } from "./config/redis";
import dotenv from "dotenv";
import wcwidth from "wcwidth";

dotenv.config();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const padAnsi = (text: string, width: number) => {
  const real = wcwidth(stripAnsi(text));
  const need = Math.max(0, width - real);
  return text + " ".repeat(need);
};

const color = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const bars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const spinnerFrames = ["🔄", "↻", "🔁", "⟳"];

(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(Order);

  process.stdout.write("\x1B[?25l");
  const restore = () => process.stdout.write("\x1B[?25h");
  process.on("exit", restore);
  process.on("SIGINT", () => {
    restore();
    process.exit();
  });

  const OPS_WINDOW = 30;
  const TPS_WINDOW = 10;
  const buckets = new Array(OPS_WINDOW).fill(0);
  let lastSec = Math.floor(Date.now() / 1000);

  const advance = (now: number) => {
    const diff = now - lastSec;
    if (diff > 0) {
      if (diff >= OPS_WINDOW) buckets.fill(0);
      else {
        for (let i = 0; i < OPS_WINDOW - diff; i++)
          buckets[i] = buckets[i + diff];
        for (let i = OPS_WINDOW - diff; i < OPS_WINDOW; i++) buckets[i] = 0;
      }
      lastSec = now;
    }
  };

  const addTs = (tsMs: number) => {
    const ts = Math.floor(tsMs / 1000);
    const now = Math.floor(Date.now() / 1000);
    advance(now);
    const off = now - ts;
    if (off >= 0 && off < OPS_WINDOW) {
      buckets[OPS_WINDOW - 1 - off]++;
    }
  };

  const computeTPS = (orders: Order[]) => {
    const now = Date.now();
    const cutoff = now - TPS_WINDOW * 1000;

    return (
      orders.filter((o) => {
        const ts = new Date((o as any).updatedAt ?? o.createdAt).getTime();
        return o.status === "confirmed" && ts >= cutoff;
      }).length / TPS_WINDOW
    );
  };

  const renderGraph = () => {
    const max = Math.max(...buckets, 1);
    return buckets
      .map((v) => {
        const idx = Math.floor((v / max) * bars.length);
        return bars[Math.min(idx, bars.length - 1)];
      })
      .join("");
  };

  const COL_ID = 12;
  const COL_STATUS = 20;
  const COL_AMOUNT = 18;
  const COL_DETAILS = 40;

  while (true) {
    const depth = await redisClient.llen("trade-queue");
    const orders = await repo.find({ order: { createdAt: "DESC" }, take: 20 });

    const nowSec = Math.floor(Date.now() / 1000);
    advance(nowSec);
    for (const o of orders) {
      const ts = new Date((o as any).updatedAt ?? o.createdAt).getTime();
      addTs(ts);
    }

    const tps = computeTPS(orders);
    const ops = buckets.reduce((a, b) => a + b, 0) / OPS_WINDOW;

    const spin =
      spinnerFrames[Math.floor(Date.now() / 200) % spinnerFrames.length];

    process.stdout.write("\x1Bc");

    const line = "=".repeat(
      COL_ID + COL_STATUS + COL_AMOUNT + COL_DETAILS + 13
    );

    console.log(line);
    console.log(" [ SOLANA EXECUTION ENGINE ]");
    console.log(line);
    console.log(` STATUS:       ${color.green("🟢 ONLINE")}`);
    console.log(` QUEUE DEPTH:  ${depth}`);
    console.log(` TIME:         ${new Date().toLocaleTimeString()}`);
    console.log("");

    console.log(
      `${color.bold("TPS:")} ${color.cyan(tps.toFixed(3))}   ` +
        `${color.bold("OPS:")} ${color.cyan(ops.toFixed(3))}   ` +
        `${color.bold("Graph:")} ${color.dim(renderGraph())}`
    );

    console.log(line);

    console.log(
      `| ${padAnsi("ID", COL_ID)} | ${padAnsi(
        "STATUS",
        COL_STATUS
      )} | ${padAnsi("AMOUNT", COL_AMOUNT)} | ${padAnsi(
        "DETAILS",
        COL_DETAILS
      )} |`
    );
    console.log(
      `| ${"-".repeat(COL_ID)} | ${"-".repeat(COL_STATUS)} | ${"-".repeat(
        COL_AMOUNT
      )} | ${"-".repeat(COL_DETAILS)} |`
    );

    for (const o of orders) {
      const id = o.id.split("-")[0];
      let icon = "⚪";
      let rowColor = (x: string) => x;

      if (o.status === "confirmed") {
        icon = "✅";
        rowColor = color.green;
      } else if (o.status === "failed") {
        icon = "❌";
        rowColor = color.red;
      } else if (o.status === "routing") {
        icon = spin;
        rowColor = color.yellow;
      } else if (o.status === "building") {
        icon = "🔨";
        rowColor = color.cyan;
      }

      const status = `${icon} ${o.status.toUpperCase()}`;
      let details = "-";
      if (o.txHash) details = `Tx: ${o.txHash.slice(0, 18)}...`;
      if (o.error) details = `Err: ${o.error.slice(0, 18)}...`;

      const amtNum = Number(o.amount);
      const amt = isNaN(amtNum) ? String(o.amount) : `${amtNum.toFixed(8)} SOL`;

      console.log(
        `| ${padAnsi(id, COL_ID)} | ` +
          `${padAnsi(rowColor(status), COL_STATUS)} | ` +
          `${padAnsi(
            o.status === "failed" ? color.red(amt) : amt,
            COL_AMOUNT
          )} | ` +
          `${padAnsi(rowColor(details), COL_DETAILS)} |`
      );
    }

    console.log(line);
    console.log("\n(Press Ctrl+C to stop)");

    await sleep(200);
  }
})();
