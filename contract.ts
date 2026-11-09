// Shared between server.ts (host client), host.ts (daemon worker) and app.tsx
// (types only). Every value crossing a boundary is validated by these schemas.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const nullableNumber = z.number().finite().nullable();

export const gpuSchema = z.object({
  name: z.string().max(200),
  utilPct: nullableNumber,
  memUsedBytes: nullableNumber,
  memTotalBytes: nullableNumber,
  tempC: nullableNumber,
  powerW: nullableNumber,
  freqMhz: nullableNumber.optional().default(null),
  maxFreqMhz: nullableNumber.optional().default(null),
});
export type GpuSample = z.infer<typeof gpuSchema>;

export const sampleSchema = z.object({
  ts: z.number().int(),
  platform: z.string().max(40),
  arch: z.string().max(40),
  hostname: z.string().max(200),
  cpuModel: z.string().max(200),
  cpuCount: z.number().int(),
  uptimeSec: z.number(),
  cpuPct: nullableNumber,
  load1: nullableNumber,
  load5: nullableNumber,
  load15: nullableNumber,
  memUsedBytes: z.number(),
  memTotalBytes: z.number(),
  swapUsedBytes: nullableNumber,
  swapTotalBytes: nullableNumber,
  diskUsedBytes: nullableNumber,
  diskTotalBytes: nullableNumber,
  diskReadBps: nullableNumber,
  diskWriteBps: nullableNumber,
  netRxBps: nullableNumber,
  netTxBps: nullableNumber,
  cpuTempC: nullableNumber,
  cpuPowerW: nullableNumber.optional().default(null),
  sysPowerW: nullableNumber.optional().default(null),
  gpus: z.array(gpuSchema).max(16),
});
export type MachineSample = z.infer<typeof sampleSchema>;

export const hostContract = defineRpcContract({
  sample: {
    input: z.null(),
    output: sampleSchema,
    experimental_retryable: true,
  },
});

// ---- Frontend RPC ----

export const RANGES = ["15m", "1h", "6h", "24h", "7d"] as const;
export type RangeKey = (typeof RANGES)[number];
export const RANGE_SECONDS: Record<RangeKey, number> = {
  "15m": 15 * 60,
  "1h": 3600,
  "6h": 6 * 3600,
  "24h": 24 * 3600,
  "7d": 7 * 24 * 3600,
};

/** One downsampled bucket; every metric is the bucket average (null = no data). */
export const pointSchema = z.object({
  ts: z.number(),
  cpuPct: nullableNumber,
  memPct: nullableNumber,
  gpuPct: nullableNumber,
  netBps: nullableNumber,
  diskIoBps: nullableNumber,
  load1: nullableNumber,
});
export type SeriesPoint = z.infer<typeof pointSchema>;

export const machineSchema = z.object({
  hostId: z.string(),
  name: z.string(),
  status: z.string(),
  lastError: z.string().nullable(),
  latest: sampleSchema.nullable(),
  points: z.array(pointSchema),
});
export type MachineSeries = z.infer<typeof machineSchema>;

export const rpcContract = defineRpcContract({
  overview: {
    input: z.object({ range: z.enum(RANGES) }).strict(),
    output: z.object({
      now: z.number(),
      intervalSec: z.number(),
      bucketSec: z.number(),
      machines: z.array(machineSchema),
    }),
  },
  current: {
    input: z.null(),
    output: z.object({
      machines: z.array(
        z.object({
          hostId: z.string(),
          name: z.string(),
          status: z.string(),
          latest: sampleSchema.nullable(),
        }),
      ),
    }),
  },
});

export const TICK_CHANNEL = "machine-load-tick";
