// Machine Load — server entry. A background service polls every connected
// machine's host worker (host.ts) on an interval, stores a compact history in
// the plugin's SQLite database, and pushes a realtime tick so open pages
// refetch. The frontend reads downsampled history over RPC.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  hostContract,
  rpcContract,
  RANGE_SECONDS,
  TICK_CHANNEL,
  type MachineSample,
  type MachineSeries,
  type SeriesPoint,
} from "./contract.js";

export { rpcContract };

type HostInfo = { id: string; name: string; status: string };
type LiveState = { latest: MachineSample | null; lastError: string | null };

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}

const pct = (used: number | null, total: number | null) =>
  used === null || total === null || total <= 0 ? null : Math.max(0, Math.min(100, (used / total) * 100));

function sumOrNull(a: number | null, b: number | null): number | null {
  return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
}

function avgGpu(sample: MachineSample): number | null {
  const utils = sample.gpus.map((g) => g.utilPct).filter((v): v is number => v !== null);
  return utils.length === 0 ? null : utils.reduce((a, b) => a + b, 0) / utils.length;
}

function fmtBytes(n: number | null): string {
  if (n === null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)}${units[i]}`;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    intervalSec: {
      type: "number",
      label: "Poll interval (seconds)",
      experimental_schema: z.number().int().min(2).max(300),
      default: 5,
    },
    retentionHours: {
      type: "number",
      label: "History retention (hours)",
      experimental_schema: z.number().int().min(1).max(24 * 30),
      default: 24 * 7,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS samples (
       host_id TEXT NOT NULL,
       ts INTEGER NOT NULL,
       cpu REAL, mem REAL, gpu REAL, net REAL, disk_io REAL, load1 REAL,
       PRIMARY KEY (host_id, ts)
     ) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS samples_ts ON samples (ts)`,
  ]);
  const insert = db.prepare(
    `INSERT OR REPLACE INTO samples (host_id, ts, cpu, mem, gpu, net, disk_io, load1)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const purge = db.prepare(`DELETE FROM samples WHERE ts < ?`);
  const bucketQuery = db.prepare(
    `SELECT host_id AS hostId, CAST(ts / @bucketMs AS INTEGER) * @bucketMs AS bucket,
            AVG(cpu) AS cpu, AVG(mem) AS mem, AVG(gpu) AS gpu,
            AVG(net) AS net, AVG(disk_io) AS diskIo, AVG(load1) AS load1
       FROM samples WHERE ts >= @since
      GROUP BY host_id, bucket ORDER BY host_id, bucket`,
  );

  const host = bb.hosts.experimental_client({ contract: hostContract });
  const live = new Map<string, LiveState>();
  let hosts: HostInfo[] = [];

  async function refreshHosts(): Promise<HostInfo[]> {
    const list = await bb.sdk.hosts.list();
    hosts = list
      .filter((h) => h.lifecycle?.phase !== "destroyed" && h.lifecycle?.phase !== "removing")
      .map((h) => ({ id: h.id, name: h.name, status: h.status }));
    return hosts;
  }

  async function pollOnce(signal: AbortSignal): Promise<void> {
    const { intervalSec } = await settings.get();
    const list = await refreshHosts();
    await Promise.all(
      list.map(async (h) => {
        const state = live.get(h.id) ?? { latest: null, lastError: null };
        live.set(h.id, state);
        if (h.status !== "connected") {
          state.lastError = `machine is ${h.status}`;
          return;
        }
        try {
          const callSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(4000, intervalSec * 1000))]);
          const s = await host.call("sample", null, { hostId: h.id, signal: callSignal });
          state.latest = s;
          state.lastError = null;
          insert.run(
            h.id,
            s.ts,
            s.cpuPct,
            pct(s.memUsedBytes, s.memTotalBytes),
            avgGpu(s),
            sumOrNull(s.netRxBps, s.netTxBps),
            sumOrNull(s.diskReadBps, s.diskWriteBps),
            s.load1,
          );
        } catch (error) {
          if (signal.aborted) return;
          state.lastError = error instanceof Error ? error.message : String(error);
        }
      }),
    );
    bb.realtime.publish(TICK_CHANNEL, { at: Date.now() });
  }

  bb.background.service("poller", {
    async start(signal) {
      let lastPurge = 0;
      while (!signal.aborted) {
        const started = Date.now();
        try {
          await pollOnce(signal);
          if (started - lastPurge > 10 * 60_000) {
            const { retentionHours } = await settings.get();
            purge.run(started - retentionHours * 3600_000);
            db.exec("PRAGMA incremental_vacuum");
            lastPurge = started;
          }
        } catch (error) {
          bb.log.warn(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const { intervalSec } = await settings.get();
        await abortableSleep(Math.max(0, intervalSec * 1000 - (Date.now() - started)), signal);
      }
    },
  });

  function sortedHosts(): HostInfo[] {
    return [...hosts].sort((a, b) => a.name.localeCompare(b.name));
  }

  bb.rpc.register(rpcContract, {
    async overview({ range }) {
      if (hosts.length === 0) await refreshHosts();
      const { intervalSec } = await settings.get();
      const rangeSec = RANGE_SECONDS[range];
      const bucketSec = Math.max(intervalSec, Math.ceil(rangeSec / 240));
      const now = Date.now();
      const rows = bucketQuery.all({ bucketMs: bucketSec * 1000, since: now - rangeSec * 1000 }) as Array<{
        hostId: string;
        bucket: number;
        cpu: number | null;
        mem: number | null;
        gpu: number | null;
        net: number | null;
        diskIo: number | null;
        load1: number | null;
      }>;
      const byHost = new Map<string, SeriesPoint[]>();
      for (const r of rows) {
        const arr = byHost.get(r.hostId) ?? [];
        arr.push({
          ts: r.bucket,
          cpuPct: r.cpu,
          memPct: r.mem,
          gpuPct: r.gpu,
          netBps: r.net,
          diskIoBps: r.diskIo,
          load1: r.load1,
        });
        byHost.set(r.hostId, arr);
      }
      const machines: MachineSeries[] = sortedHosts().map((h) => ({
        hostId: h.id,
        name: h.name,
        status: h.status,
        lastError: live.get(h.id)?.lastError ?? null,
        latest: live.get(h.id)?.latest ?? null,
        points: byHost.get(h.id) ?? [],
      }));
      return { now, intervalSec, bucketSec, machines };
    },
    async current() {
      if (hosts.length === 0) await refreshHosts();
      return {
        machines: sortedHosts().map((h) => ({
          hostId: h.id,
          name: h.name,
          status: h.status,
          latest: live.get(h.id)?.latest ?? null,
        })),
      };
    },
  });

  bb.cli.register({
    name: "machine-load",
    summary: "Show current hardware load (CPU, RAM, disk, GPU, network) of every bb machine",
    commands: [{ name: "status", summary: "Current load of every machine", usage: "bb machine-load [status] [--json]" }],
    async run(argv) {
      const json = argv.includes("--json");
      const cmd = argv.find((a) => a !== "--json") ?? "status";
      if (cmd === "help" || cmd === "--help") return { exitCode: 0, stdout: "Usage: bb machine-load [status] [--json]" };
      if (cmd !== "status") return { exitCode: 1, stderr: "Usage: bb machine-load [status] [--json]" };
      if (hosts.length === 0) await refreshHosts();
      const rows = sortedHosts().map((h) => ({ ...h, ...live.get(h.id) }));
      if (json) {
        return { exitCode: 0, stdout: JSON.stringify(rows.map((r) => ({ hostId: r.id, name: r.name, status: r.status, lastError: r.lastError ?? null, latest: r.latest ?? null }))) };
      }
      const lines = rows.map((r) => {
        const s = r.latest;
        if (!s) return `${r.name}  (${r.status})  no data${r.lastError ? `: ${r.lastError}` : ""}`;
        const gpu = s.gpus.length ? `  GPU ${s.gpus.map((g) => (g.utilPct === null ? "?" : `${g.utilPct.toFixed(0)}%`)).join("/")}` : "";
        return [
          `${r.name}  (${s.platform}/${s.arch}, ${s.cpuCount} cores)`,
          `  CPU ${s.cpuPct?.toFixed(0) ?? "?"}%  load ${s.load1?.toFixed(2) ?? "—"}`,
          `  RAM ${fmtBytes(s.memUsedBytes)}/${fmtBytes(s.memTotalBytes)}  swap ${fmtBytes(s.swapUsedBytes)}`,
          `  Disk ${fmtBytes(s.diskUsedBytes)}/${fmtBytes(s.diskTotalBytes)}  IO r ${fmtBytes(s.diskReadBps)}/s w ${fmtBytes(s.diskWriteBps)}/s`,
          `  Net ↓${fmtBytes(s.netRxBps)}/s ↑${fmtBytes(s.netTxBps)}/s${gpu}${s.cpuTempC !== null ? `  ${s.cpuTempC.toFixed(0)}°C` : ""}`,
        ].join("\n");
      });
      return { exitCode: 0, stdout: lines.join("\n\n") || "No machines." };
    },
  });
}
