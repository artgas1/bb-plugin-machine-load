// Machine Load — frontend. A sidebar page with time-series charts of every
// bb machine's hardware load plus a card per machine with current values.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  definePluginApp,
  experimental_useCodeTheme as useCodeTheme,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import {
  RANGES,
  RANGE_SECONDS,
  TICK_CHANNEL,
  type MachineSample,
  type MachineSeries,
  type RangeKey,
  type SeriesPoint,
  type rpcContract,
} from "./contract";
import { cn } from "@/lib/utils";

// ---------- palette (validated categorical slots, light + dark steps) ----------

const SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

function useSeriesColors(): string[] {
  const { mode } = useCodeTheme();
  return mode === "dark" ? SERIES_DARK : SERIES_LIGHT;
}

// ---------- formatting ----------

function fmtBytes(n: number | null | undefined, suffix = ""): string {
  if (n === null || n === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}${suffix}`;
}
const fmtPct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n.toFixed(0)}%`);
function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function fmtTime(ts: number, rangeSec: number): string {
  const d = new Date(ts);
  if (rangeSec > 2 * 86400) {
    return d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", ...(rangeSec <= 900 ? { second: "2-digit" } : {}) });
}
const pctOf = (used: number | null, total: number | null) =>
  used === null || total === null || total <= 0 ? null : (used / total) * 100;

// ---------- data ----------

type Overview = { now: number; intervalSec: number; bucketSec: number; machines: MachineSeries[] };

const MIN_REFETCH_MS: Record<RangeKey, number> = { "15m": 0, "1h": 0, "6h": 15_000, "24h": 30_000, "7d": 60_000 };

function useOverview(range: RangeKey) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastFetch = useRef(0);
  const inFlight = useRef(false);
  const fetchNow = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    lastFetch.current = Date.now();
    rpc
      .call("overview", { range })
      .then(
        (result) => {
          setData(result);
          setError(null);
        },
        (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => {
        inFlight.current = false;
      });
  }, [rpc, range]);
  useEffect(() => {
    setData(null);
    fetchNow();
  }, [fetchNow]);
  useRealtime(TICK_CHANNEL, () => {
    if (Date.now() - lastFetch.current >= MIN_REFETCH_MS[range]) fetchNow();
  });
  return { data, error };
}

// ---------- chart ----------

type ChartSeries = { key: string; label: string; color: string; points: Array<{ ts: number; v: number | null }> };

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function niceMax(max: number): number {
  if (max <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  for (const m of [1, 2, 2.5, 5, 10]) if (max <= m * exp) return m * exp;
  return 10 * exp;
}
function niceBytesMax(max: number): number {
  if (max <= 0) return 1024;
  let unit = 1;
  while (max / unit >= 1024) unit *= 1024;
  return niceMax(max / unit) * unit;
}

function LineChart({
  title,
  series,
  from,
  to,
  bucketMs,
  kind,
  rangeSec,
  showLegendAlways = false,
}: {
  showLegendAlways?: boolean;
  title: string;
  series: ChartSeries[];
  from: number;
  to: number;
  bucketMs: number;
  kind: "pct" | "bytes";
  rangeSec: number;
}) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [hoverTs, setHoverTs] = useState<number | null>(null);
  const height = 168;
  const m = { top: 8, right: 12, bottom: 22, left: kind === "pct" ? 36 : 64 };
  const iw = Math.max(10, width - m.left - m.right);
  const ih = height - m.top - m.bottom;

  const yMax = useMemo(() => {
    if (kind === "pct") return 100;
    let max = 0;
    for (const s of series) for (const p of s.points) if (p.v !== null && p.v > max) max = p.v;
    return niceBytesMax(max * 1.1);
  }, [series, kind]);

  const x = (ts: number) => m.left + ((ts - from) / (to - from)) * iw;
  const y = (v: number) => m.top + ih - (Math.min(v, yMax) / yMax) * ih;
  const yTicks = kind === "pct" ? [0, 25, 50, 75, 100] : [0, yMax / 2, yMax];
  const fmtY = (v: number) => (kind === "pct" ? `${v}%` : fmtBytes(v, "/s"));
  const fmtV = (v: number | null) => (kind === "pct" ? fmtPct(v) : fmtBytes(v, "/s"));

  const xTicks = useMemo(() => {
    const count = Math.max(2, Math.min(6, Math.floor(iw / 110)));
    return Array.from({ length: count + 1 }, (_, i) => from + ((to - from) * i) / count);
  }, [from, to, iw]);

  const paths = useMemo(
    () =>
      series.map((s) => {
        let d = "";
        let prevTs: number | null = null;
        for (const p of s.points) {
          if (p.v === null) {
            prevTs = null;
            continue;
          }
          const gap = prevTs !== null && p.ts - prevTs > bucketMs * 2.5;
          d += `${d === "" || prevTs === null || gap ? "M" : "L"}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`;
          prevTs = p.ts;
        }
        return d;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, from, to, iw, yMax, bucketMs],
  );

  // Nearest point per series to the hovered time.
  const hover = useMemo(() => {
    if (hoverTs === null) return null;
    let snapTs: number | null = null;
    const values = series.map((s): { s: ChartSeries; p: { ts: number; v: number | null } | null } => {
      let best = null as { ts: number; v: number | null } | null;
      for (const p of s.points) {
        if (best === null || Math.abs(p.ts - hoverTs) < Math.abs(best.ts - hoverTs)) best = p;
      }
      if (best && Math.abs(best.ts - hoverTs) > bucketMs * 1.5) best = null;
      if (best && (snapTs === null || Math.abs(best.ts - hoverTs) < Math.abs(snapTs - hoverTs))) snapTs = best.ts;
      return { s, p: best };
    });
    return snapTs === null ? null : { ts: snapTs as number, values };
  }, [hoverTs, series, bucketMs]);

  const hasData = series.some((s) => s.points.some((p) => p.v !== null));
  const latest = (s: ChartSeries) => {
    for (let i = s.points.length - 1; i >= 0; i--) if (s.points[i]!.v !== null) return s.points[i]!.v;
    return null;
  };

  return (
    <section className="rounded-lg border border-border bg-card p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {series.length > 1 || showLegendAlways ? (
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-label={`${title} legend`}>
            {series.map((s) => (
              <li key={s.key} className="flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: s.color }} />
                <span>{s.label}</span>
                <span className="tabular-nums text-foreground">{fmtV(latest(s))}</span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-xs tabular-nums text-foreground">{fmtV(series[0] ? latest(series[0]) : null)}</span>
        )}
      </div>
      <div ref={wrapRef} className="relative w-full" style={{ height }}>
        {width > 0 ? (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`${title} over time`}
            className="block touch-none select-none"
            onPointerMove={(e) => {
              const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
              const px = e.clientX - rect.left;
              if (px < m.left || px > m.left + iw) return setHoverTs(null);
              setHoverTs(from + ((px - m.left) / iw) * (to - from));
            }}
            onPointerLeave={() => setHoverTs(null)}
          >
            {yTicks.map((t) => (
              <g key={t}>
                <line x1={m.left} x2={m.left + iw} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={1} strokeDasharray={t === 0 ? undefined : "2 3"} />
                <text x={m.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">
                  {fmtY(t)}
                </text>
              </g>
            ))}
            {xTicks.map((t, i) => (
              <text
                key={t}
                x={x(t)}
                y={height - 6}
                textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
                className="fill-muted-foreground text-[10px] tabular-nums"
              >
                {i === xTicks.length - 1 ? "now" : fmtTime(t, rangeSec)}
              </text>
            ))}
            {series.map((s, i) => (
              <path key={s.key} d={paths[i]} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {hover ? (
              <g pointerEvents="none">
                <line x1={x(hover.ts)} x2={x(hover.ts)} y1={m.top} y2={m.top + ih} className="stroke-muted-foreground" strokeWidth={1} />
                {hover.values.map(({ s, p }) =>
                  p && p.v !== null ? (
                    <circle key={s.key} cx={x(p.ts)} cy={y(p.v)} r={4} fill={s.color} className="stroke-card" strokeWidth={2} />
                  ) : null,
                )}
              </g>
            ) : null}
          </svg>
        ) : null}
        {!hasData && width > 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">Collecting data…</div>
        ) : null}
        {hover ? (
          <div
            className="pointer-events-none absolute top-1 z-10 min-w-36 rounded-md border border-border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md"
            style={
              (x(hover.ts) > width / 2
                ? { right: width - x(hover.ts) + 10 }
                : { left: x(hover.ts) + 10 }) as CSSProperties
            }
          >
            <div className="mb-1 text-muted-foreground">{new Date(hover.ts).toLocaleString()}</div>
            {hover.values.map(({ s, p }) => (
              <div key={s.key} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block size-2 rounded-full" style={{ background: s.color }} />
                  {s.label}
                </span>
                <span className="tabular-nums">{fmtV(p?.v ?? null)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

// ---------- machine card ----------

function Meter({ label, value, detail, percent }: { label: string; value: string; detail?: string; percent?: number | null }) {
  const p = percent === null || percent === undefined ? null : Math.max(0, Math.min(100, percent));
  return (
    <div className="min-w-0 rounded-md bg-muted/40 px-2.5 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-base font-medium tabular-nums text-foreground">{value}</div>
      {detail ? <div className="line-clamp-2 break-words text-xs tabular-nums text-muted-foreground">{detail}</div> : null}
      {p !== null ? (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border" aria-hidden>
          <div className={cn("h-full rounded-full", p >= 90 ? "bg-destructive" : "bg-foreground/60")} style={{ width: `${p}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function StatusPill({ machine }: { machine: MachineSeries }) {
  const ok = machine.status === "connected" && machine.lastError === null && machine.latest !== null;
  const label = machine.status !== "connected" ? machine.status : machine.lastError ? "error" : machine.latest ? "live" : "waiting";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
      title={machine.lastError ?? undefined}
    >
      <span className={cn("inline-block size-1.5 rounded-full", ok ? "bg-emerald-500" : label === "waiting" ? "bg-muted-foreground" : "bg-destructive")} />
      {label}
    </span>
  );
}

function MachineCard({ machine, color, now }: { machine: MachineSeries; color: string; now: number }) {
  const s: MachineSample | null = machine.latest;
  const stale = s !== null && now - s.ts > 60_000;
  return (
    <section className="rounded-lg border border-border bg-card p-3">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-block size-2.5 rounded-full" style={{ background: color }} aria-hidden />
        <h3 className="text-sm font-semibold text-foreground">{machine.name}</h3>
        <StatusPill machine={machine} />
        {s ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {s.platform}/{s.arch} · {s.cpuCount} threads · {s.cpuModel} · up {fmtUptime(s.uptimeSec)}
            {stale ? ` · last sample ${Math.round((now - s.ts) / 1000)}s ago` : ""}
          </span>
        ) : null}
      </header>
      {machine.lastError && machine.status === "connected" ? (
        <p className="mt-2 text-xs text-destructive">{machine.lastError}</p>
      ) : null}
      {s ? (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          <Meter
            label="CPU"
            value={fmtPct(s.cpuPct)}
            detail={s.load1 !== null ? `load ${s.load1.toFixed(2)} · ${s.load5?.toFixed(2)} · ${s.load15?.toFixed(2)}` : undefined}
            percent={s.cpuPct}
          />
          <Meter
            label="Memory"
            value={fmtPct(pctOf(s.memUsedBytes, s.memTotalBytes))}
            detail={`${fmtBytes(s.memUsedBytes)} / ${fmtBytes(s.memTotalBytes)}`}
            percent={pctOf(s.memUsedBytes, s.memTotalBytes)}
          />
          {s.swapTotalBytes ? (
            <Meter
              label="Swap"
              value={fmtPct(pctOf(s.swapUsedBytes, s.swapTotalBytes))}
              detail={`${fmtBytes(s.swapUsedBytes)} / ${fmtBytes(s.swapTotalBytes)}`}
              percent={pctOf(s.swapUsedBytes, s.swapTotalBytes)}
            />
          ) : null}
          {s.diskTotalBytes ? (
            <Meter
              label="Disk"
              value={fmtPct(pctOf(s.diskUsedBytes, s.diskTotalBytes))}
              detail={`${fmtBytes(s.diskUsedBytes)} / ${fmtBytes(s.diskTotalBytes)}`}
              percent={pctOf(s.diskUsedBytes, s.diskTotalBytes)}
            />
          ) : null}
          <Meter label="Disk IO" value={`R ${fmtBytes(s.diskReadBps, "/s")}`} detail={`W ${fmtBytes(s.diskWriteBps, "/s")}`} />
          <Meter label="Network" value={`↓ ${fmtBytes(s.netRxBps, "/s")}`} detail={`↑ ${fmtBytes(s.netTxBps, "/s")}`} />
          {s.cpuTempC !== null || s.cpuPowerW !== null ? (
            <Meter
              label="CPU sensors"
              value={s.cpuTempC !== null ? `${s.cpuTempC.toFixed(0)}°C` : `${s.cpuPowerW!.toFixed(1)} W`}
              detail={[
                s.cpuTempC !== null && s.cpuPowerW !== null ? `CPU ${s.cpuPowerW.toFixed(1)} W` : null,
                s.sysPowerW !== null ? `system ${s.sysPowerW.toFixed(1)} W` : null,
              ]
                .filter(Boolean)
                .join(" · ") || undefined}
            />
          ) : null}
          {s.gpus.map((g, i) => (
            <Meter
              key={i}
              label={s.gpus.length > 1 ? `GPU ${i}` : "GPU"}
              value={fmtPct(g.utilPct)}
              detail={[
                g.name,
                g.memTotalBytes ? `${fmtBytes(g.memUsedBytes)} / ${fmtBytes(g.memTotalBytes)}` : g.memUsedBytes ? `${fmtBytes(g.memUsedBytes)} used` : null,
                g.tempC !== null ? `${g.tempC.toFixed(0)}°C` : null,
                g.powerW !== null ? `${g.powerW.toFixed(g.powerW < 10 ? 1 : 0)} W` : null,
                g.freqMhz !== null ? `${g.freqMhz.toFixed(0)}${g.maxFreqMhz ? `/${g.maxFreqMhz.toFixed(0)}` : ""} MHz` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              percent={g.utilPct}
            />
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">No samples yet.</p>
      )}
    </section>
  );
}

// ---------- page ----------

function RangePicker({ value, onChange }: { value: RangeKey; onChange: (r: RangeKey) => void }) {
  return (
    <div role="radiogroup" aria-label="Time range" className="inline-flex rounded-md border border-border bg-card p-0.5">
      {RANGES.map((r) => (
        <button
          key={r}
          type="button"
          role="radio"
          aria-checked={r === value}
          onClick={() => onChange(r)}
          className={cn(
            "rounded px-2.5 py-1 text-xs tabular-nums transition-colors",
            r === value ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {r}
        </button>
      ))}
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

const RANGE_STORAGE_KEY = "bb-plugin-machine-load:range";

function MachinesPage() {
  const [range, setRange] = useState<RangeKey>(() => {
    const saved = typeof localStorage === "undefined" ? null : localStorage.getItem(RANGE_STORAGE_KEY);
    return (RANGES as readonly string[]).includes(saved ?? "") ? (saved as RangeKey) : "1h";
  });
  const pickRange = (r: RangeKey) => {
    setRange(r);
    try {
      localStorage.setItem(RANGE_STORAGE_KEY, r);
    } catch {
      // ignore
    }
  };
  const { data, error } = useOverview(range);
  const colors = useSeriesColors();
  const rangeSec = RANGE_SECONDS[range];

  const charts = useMemo(() => {
    if (!data) return null;
    const colorOf = (i: number) => colors[i % colors.length]!;
    const build = (pick: (p: SeriesPoint) => number | null) =>
      data.machines.map((mach, i) => ({
        key: mach.hostId,
        label: mach.name,
        color: colorOf(i),
        points: mach.points.map((p) => ({ ts: p.ts, v: pick(p) })),
      }));
    const gpu = build((p) => p.gpuPct).filter((s) => s.points.some((p) => p.v !== null));
    return {
      cpu: build((p) => p.cpuPct),
      mem: build((p) => p.memPct),
      gpu,
      net: build((p) => p.netBps),
      disk: build((p) => p.diskIoBps),
    };
  }, [data, colors]);

  const to = data?.now ?? Date.now();
  const from = to - rangeSec * 1000;
  const bucketMs = (data?.bucketSec ?? 5) * 1000;
  const common = { from, to, bucketMs, rangeSec };

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-6xl px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Hardware load of every bb machine
            {data ? ` · sampled every ${data.intervalSec}s · ${data.bucketSec}s buckets` : ""}
          </p>
          <RangePicker value={range} onChange={pickRange} />
        </div>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {!data || !charts ? (
          <div className="mt-4">
            <EmptyState>Loading…</EmptyState>
          </div>
        ) : data.machines.length === 0 ? (
          <div className="mt-4">
            <EmptyState>No machines enrolled.</EmptyState>
          </div>
        ) : (
          <>
            <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-2">
              <LineChart title="CPU" series={charts.cpu} kind="pct" {...common} />
              <LineChart title="Memory" series={charts.mem} kind="pct" {...common} />
              {charts.gpu.length > 0 ? <LineChart title="GPU" series={charts.gpu} kind="pct" showLegendAlways {...common} /> : null}
              <LineChart title="Network (rx + tx)" series={charts.net} kind="bytes" {...common} />
              <LineChart title="Disk IO (read + write)" series={charts.disk} kind="bytes" {...common} />
            </div>
            <h2 className="mb-2 mt-6 text-sm font-medium text-foreground">Machines</h2>
            <div className="grid grid-cols-1 gap-3">
              {data.machines.map((mach, i) => (
                <MachineCard key={mach.hostId} machine={mach} color={colors[i % colors.length]!} now={data.now} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Sidebar badge: the busiest machine's CPU, tinted when anything runs hot.
function useLoadBadge() {
  const rpc = useRpc<typeof rpcContract>();
  const [badge, setBadge] = useState<{ text: string; label: string; tone: "neutral" | "warning" | "critical" } | null>(null);
  const last = useRef(0);
  const refresh = useCallback(() => {
    if (Date.now() - last.current < 10_000) return;
    last.current = Date.now();
    rpc.call("current").then(
      ({ machines }) => {
        let worst: { name: string; cpu: number; mem: number } | null = null;
        for (const mach of machines) {
          const s = mach.latest;
          if (!s || s.cpuPct === null) continue;
          const mem = (s.memUsedBytes / s.memTotalBytes) * 100;
          if (!worst || Math.max(s.cpuPct, mem) > Math.max(worst.cpu, worst.mem)) worst = { name: mach.name, cpu: s.cpuPct, mem };
        }
        if (!worst) return setBadge(null);
        const peak = Math.max(worst.cpu, worst.mem);
        setBadge(
          peak < 80
            ? null
            : {
                text: `${peak.toFixed(0)}%`,
                label: `${worst.name}: CPU ${worst.cpu.toFixed(0)}%, RAM ${worst.mem.toFixed(0)}%`,
                tone: peak >= 95 ? "critical" : "warning",
              },
        );
      },
      () => setBadge(null),
    );
  }, [rpc]);
  useEffect(refresh, [refresh]);
  useRealtime(TICK_CHANNEL, refresh);
  return badge;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "machines",
    title: "Machines",
    icon: "machine-load/pulse",
    path: "machines",
    component: MachinesPage,
    experimental_useBadge: useLoadBadge,
  });
});
