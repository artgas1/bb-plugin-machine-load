// Runs inside the bb daemon on every enrolled machine. Collects a hardware
// snapshot without root: Linux via /proc and /sys, macOS via vm_stat, sysctl,
// netstat and ioreg; GPUs via nvidia-smi, AMD sysfs or Apple's IOAccelerator.
// Rates (CPU %, network, disk IO) are deltas against the previous call.
import { execFile } from "node:child_process";
import { readFile, readdir, readlink, realpath, statfs } from "node:fs/promises";
import { basename } from "node:path";
import os from "node:os";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, type GpuSample, type MachineSample } from "./contract.js";

const platform = os.platform();

function run(cmd: string, args: string[], timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function num(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

// ---------- CPU ----------

type CpuTimes = { idle: number; total: number };
function cpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

// ---------- Memory ----------

type Mem = { used: number; total: number; swapUsed: number | null; swapTotal: number | null };

async function memLinux(): Promise<Mem | null> {
  const text = await readText("/proc/meminfo");
  if (text === null) return null;
  const kv = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = /^(\w+(?:\(\w+\))?):\s+(\d+)/.exec(line);
    if (m) kv.set(m[1]!, Number(m[2]) * 1024);
  }
  const total = kv.get("MemTotal");
  const avail = kv.get("MemAvailable") ?? kv.get("MemFree");
  if (total === undefined || avail === undefined) return null;
  const swapTotal = kv.get("SwapTotal") ?? null;
  const swapFree = kv.get("SwapFree") ?? null;
  return {
    used: total - avail,
    total,
    swapTotal,
    swapUsed: swapTotal !== null && swapFree !== null ? swapTotal - swapFree : null,
  };
}

async function memDarwin(): Promise<Mem | null> {
  const total = os.totalmem();
  const out = await run("vm_stat", []);
  let used = total - os.freemem();
  if (out !== null) {
    const pageSize = num(/page size of (\d+) bytes/.exec(out)?.[1]) ?? 4096;
    const page = (label: string) => num(new RegExp(`${label}:\\s+(\\d+)`).exec(out)?.[1]) ?? null;
    const anon = page("Anonymous pages");
    const purgeable = page("Pages purgeable") ?? 0;
    const wired = page("Pages wired down");
    const compressed = page("Pages occupied by compressor") ?? 0;
    if (anon !== null && wired !== null) {
      // Activity Monitor's "Memory Used" = app memory + wired + compressed.
      used = (anon - purgeable + wired + compressed) * pageSize;
    } else {
      const free = page("Pages free") ?? 0;
      const inactive = page("Pages inactive") ?? 0;
      const spec = page("Pages speculative") ?? 0;
      used = total - (free + inactive + spec) * pageSize;
    }
  }
  let swapUsed: number | null = null;
  let swapTotal: number | null = null;
  const swap = await run("sysctl", ["-n", "vm.swapusage"]);
  if (swap !== null) {
    const toBytes = (s: string | undefined) => {
      const m = /([\d.]+)([KMGT])/.exec(s ?? "");
      if (!m) return null;
      const mult = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2] as "K"];
      return Number(m[1]) * mult;
    };
    swapTotal = toBytes(/total = (\S+)/.exec(swap)?.[1]);
    swapUsed = toBytes(/used = (\S+)/.exec(swap)?.[1]);
  }
  return { used: Math.max(0, Math.min(used, total)), total, swapUsed, swapTotal };
}

async function memory(): Promise<Mem> {
  const m = platform === "linux" ? await memLinux() : platform === "darwin" ? await memDarwin() : null;
  if (m) return m;
  const total = os.totalmem();
  return { used: total - os.freemem(), total, swapUsed: null, swapTotal: null };
}

// ---------- Disk usage ----------

async function diskUsage(): Promise<{ used: number; total: number } | null> {
  const candidates = platform === "darwin" ? ["/System/Volumes/Data", "/"] : platform === "win32" ? ["C:\\"] : ["/"];
  for (const path of candidates) {
    try {
      const s = await statfs(path);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      // Used as seen by users (df): total minus what an unprivileged user can still write.
      return { used: total - free, total };
    } catch {
      // try next
    }
  }
  return null;
}

// ---------- Counters (network + disk IO) ----------

type Counters = { netRx: number | null; netTx: number | null; diskRead: number | null; diskWrite: number | null };

const SKIP_NET_LINUX = /^(lo|veth|docker|br-|virbr|tun|tap|cni|flannel|cali|vxlan|tailscale|wg|zt)/;
const SKIP_NET_DARWIN = /^(lo|utun|gif|stf|awdl|llw|bridge|anpi|ap\d|ipsec)/;

async function countersLinux(): Promise<Counters> {
  let netRx: number | null = null;
  let netTx: number | null = null;
  const net = await readText("/proc/net/dev");
  if (net !== null) {
    netRx = 0;
    netTx = 0;
    for (const line of net.split("\n").slice(2)) {
      const [name, rest] = line.split(":");
      if (!name || !rest) continue;
      if (SKIP_NET_LINUX.test(name.trim())) continue;
      const f = rest.trim().split(/\s+/);
      netRx += Number(f[0]) || 0;
      netTx += Number(f[8]) || 0;
    }
  }
  let diskRead: number | null = null;
  let diskWrite: number | null = null;
  const stats = await readText("/proc/diskstats");
  let blockDevs: Set<string> | null = null;
  try {
    blockDevs = new Set(await readdir("/sys/block"));
  } catch {
    blockDevs = null;
  }
  if (stats !== null) {
    diskRead = 0;
    diskWrite = 0;
    for (const line of stats.split("\n")) {
      const f = line.trim().split(/\s+/);
      const name = f[2];
      if (!name || f.length < 10) continue;
      if (/^(loop|ram|zram|dm-|md|sr|fd)/.test(name)) continue;
      // Whole devices only, so partitions are not counted twice.
      if (blockDevs ? !blockDevs.has(name) : /\d$/.test(name) && !/nvme\d+n\d+$/.test(name)) continue;
      diskRead += (Number(f[5]) || 0) * 512;
      diskWrite += (Number(f[9]) || 0) * 512;
    }
  }
  return { netRx, netTx, diskRead, diskWrite };
}

async function countersDarwin(): Promise<Counters> {
  let netRx: number | null = null;
  let netTx: number | null = null;
  const net = await run("netstat", ["-ibn"]);
  if (net !== null) {
    netRx = 0;
    netTx = 0;
    const seen = new Set<string>();
    for (const line of net.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 7 || !f[2]?.startsWith("<Link#")) continue;
      const name = f[0]!.replace(/\*$/, "");
      if (seen.has(name) || SKIP_NET_DARWIN.test(name)) continue;
      seen.add(name);
      // Count from the end: ... Ibytes Opkts Oerrs Obytes Coll
      netRx += Number(f[f.length - 5]) || 0;
      netTx += Number(f[f.length - 2]) || 0;
    }
  }
  let diskRead: number | null = null;
  let diskWrite: number | null = null;
  const io = await run("ioreg", ["-c", "IOBlockStorageDriver", "-r", "-w", "0", "-k", "Statistics"]);
  if (io !== null) {
    diskRead = 0;
    diskWrite = 0;
    for (const m of io.matchAll(/"Bytes \(Read\)"=(\d+)/g)) diskRead += Number(m[1]);
    for (const m of io.matchAll(/"Bytes \(Write\)"=(\d+)/g)) diskWrite += Number(m[1]);
  }
  return { netRx, netTx, diskRead, diskWrite };
}

async function counters(): Promise<Counters> {
  if (platform === "linux") return countersLinux();
  if (platform === "darwin") return countersDarwin();
  return { netRx: null, netTx: null, diskRead: null, diskWrite: null };
}

// ---------- Temperature ----------

async function cpuTempLinux(): Promise<number | null> {
  try {
    const dirs = await readdir("/sys/class/hwmon");
    for (const wanted of ["coretemp", "k10temp", "zenpower", "cpu_thermal", "acpitz"]) {
      for (const dir of dirs) {
        const name = (await readText(`/sys/class/hwmon/${dir}/name`))?.trim();
        if (name !== wanted) continue;
        const t = num((await readText(`/sys/class/hwmon/${dir}/temp1_input`)) ?? undefined);
        if (t !== null && t > 0) return t / 1000;
      }
    }
  } catch {
    // no hwmon
  }
  return null;
}

// ---------- GPU ----------

let nvidiaMissingUntil = 0;

async function gpusNvidia(): Promise<GpuSample[]> {
  if (Date.now() < nvidiaMissingUntil) return [];
  const out = await run("nvidia-smi", [
    "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
    "--format=csv,noheader,nounits",
  ]);
  if (out === null) {
    nvidiaMissingUntil = Date.now() + 5 * 60_000;
    return [];
  }
  const mib = 1024 * 1024;
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(0, 16)
    .map((line) => {
      const [name, util, used, total, temp, power] = line.split(",").map((s) => s.trim());
      const n = (s: string | undefined) => (s === undefined || /N\/A|\[/.test(s) ? null : num(s));
      return {
        name: (name ?? "NVIDIA GPU").slice(0, 200),
        utilPct: n(util),
        memUsedBytes: n(used) === null ? null : n(used)! * mib,
        memTotalBytes: n(total) === null ? null : n(total)! * mib,
        tempC: n(temp),
        powerW: n(power),
        freqMhz: null,
        maxFreqMhz: null,
      };
    });
}

async function gpusAmdSysfs(): Promise<GpuSample[]> {
  const result: GpuSample[] = [];
  try {
    for (const card of await readdir("/sys/class/drm")) {
      if (!/^card\d+$/.test(card)) continue;
      const base = `/sys/class/drm/${card}/device`;
      const util = num((await readText(`${base}/gpu_busy_percent`)) ?? undefined);
      if (util === null) continue;
      result.push({
        name: `AMD GPU (${card})`,
        utilPct: util,
        memUsedBytes: num((await readText(`${base}/mem_info_vram_used`)) ?? undefined),
        memTotalBytes: num((await readText(`${base}/mem_info_vram_total`)) ?? undefined),
        tempC: null,
        powerW: null,
        freqMhz: num((await readText(`/sys/class/drm/${card}/device/pp_dpm_sclk`))?.match(/(\d+)Mhz \*/)?.[1]),
        maxFreqMhz: null,
      });
    }
  } catch {
    // no drm
  }
  return result;
}

// Intel (i915/xe) and other DRM GPUs without a busy-percent file: per-client
// engine counters from /proc/<pid>/fdinfo (no root; only this user's
// processes are visible, which covers the desktop session).

type DrmClient = { pdev: string; driver: string; engines: Map<string, number>; cycles: Map<string, [number, number]> };
type DrmFd = { pid: string; fd: string };
let drmFds: DrmFd[] = [];
let drmFdsScannedAt = 0;
let drmPrev: { at: number; clients: Map<string, DrmClient> } | null = null;
const pciNames = new Map<string, string>();

async function scanDrmFds(): Promise<void> {
  const found: DrmFd[] = [];
  let pids: string[] = [];
  try {
    pids = (await readdir("/proc")).filter((d) => /^\d+$/.test(d));
  } catch {
    return;
  }
  await Promise.all(
    pids.map(async (pid) => {
      let fds: string[];
      try {
        fds = await readdir(`/proc/${pid}/fd`);
      } catch {
        return;
      }
      await Promise.all(
        fds.map(async (fd) => {
          try {
            const target = await readlink(`/proc/${pid}/fd/${fd}`);
            if (target.startsWith("/dev/dri/")) found.push({ pid, fd });
          } catch {
            // fd closed meanwhile
          }
        }),
      );
    }),
  );
  drmFds = found;
  drmFdsScannedAt = Date.now();
}

async function readDrmClients(): Promise<Map<string, DrmClient>> {
  if (Date.now() - drmFdsScannedAt > 60_000) await scanDrmFds();
  const clients = new Map<string, DrmClient>();
  const alive: DrmFd[] = [];
  await Promise.all(
    drmFds.map(async (ref) => {
      const text = await readText(`/proc/${ref.pid}/fdinfo/${ref.fd}`);
      if (text === null) return;
      alive.push(ref);
      const id = /^drm-client-id:\s*(\d+)/m.exec(text)?.[1];
      const pdev = /^drm-pdev:\s*(\S+)/m.exec(text)?.[1];
      const driver = /^drm-driver:\s*(\S+)/m.exec(text)?.[1];
      if (!id || !pdev || !driver) return;
      const key = `${pdev}#${id}`;
      if (clients.has(key)) return; // same client shared by several fds
      const engines = new Map<string, number>();
      for (const m of text.matchAll(/^drm-engine-([\w-]+):\s*(\d+)\s*ns/gm)) engines.set(m[1]!, Number(m[2]));
      const cycles = new Map<string, [number, number]>();
      for (const m of text.matchAll(/^drm-cycles-([\w-]+):\s*(\d+)/gm)) {
        const total = num(new RegExp(`^drm-total-cycles-${m[1]}:\\s*(\\d+)`, "m").exec(text)?.[1]);
        if (total !== null) cycles.set(m[1]!, [Number(m[2]), total]);
      }
      clients.set(key, { pdev, driver, engines, cycles });
    }),
  );
  drmFds = alive;
  return clients;
}

async function pciName(pdev: string): Promise<string | null> {
  if (pciNames.has(pdev)) return pciNames.get(pdev)!;
  const out = await run("lspci", ["-s", pdev, "-mm"]);
  // "00:02.0" "VGA compatible controller" "Intel Corporation" "Raptor Lake-P [UHD Graphics]" ...
  const parts = out ? [...out.matchAll(/"([^"]*)"/g)].map((m) => m[1]!) : [];
  const vendor = (parts[1] ?? "").replace(/ Corporation| Inc\.?|,/g, "").trim();
  const name = parts[2] ? `${vendor} ${parts[2]}`.trim() : null;
  pciNames.set(pdev, name ?? "");
  return name;
}

async function gpusDrmFdinfo(skipDrivers: Set<string>): Promise<GpuSample[]> {
  // Cards bound to drivers that expose no busy file.
  const cards: Array<{ card: string; pdev: string; driver: string }> = [];
  try {
    for (const card of await readdir("/sys/class/drm")) {
      if (!/^card\d+$/.test(card)) continue;
      try {
        const driver = basename(await readlink(`/sys/class/drm/${card}/device/driver`));
        if (skipDrivers.has(driver) || !["i915", "xe"].includes(driver)) continue;
        const pdev = basename(await realpath(`/sys/class/drm/${card}/device`));
        cards.push({ card, pdev, driver });
      } catch {
        // virtual card
      }
    }
  } catch {
    return [];
  }
  if (cards.length === 0) return [];
  const at = Date.now();
  const clients = await readDrmClients();
  const before = drmPrev;
  drmPrev = { at, clients };
  const result: GpuSample[] = [];
  for (const { card, pdev, driver } of cards) {
    let utilPct: number | null = null;
    if (before) {
      const dtNs = (at - before.at) * 1e6;
      const busyNs = new Map<string, number>();
      const cyc = new Map<string, [number, number]>();
      for (const [key, c] of clients) {
        if (c.pdev !== pdev) continue;
        const old = before.clients.get(key);
        if (!old) continue; // new client: no baseline yet
        for (const [eng, v] of c.engines) {
          const d = v - (old.engines.get(eng) ?? v);
          if (d > 0) busyNs.set(eng, (busyNs.get(eng) ?? 0) + d);
        }
        for (const [eng, [cy, total]] of c.cycles) {
          const o = old.cycles.get(eng);
          if (!o) continue;
          const acc = cyc.get(eng) ?? [0, 0];
          acc[0] += Math.max(0, cy - o[0]);
          acc[1] = Math.max(acc[1], total - o[1]);
          cyc.set(eng, acc);
        }
      }
      // Busiest engine class, like intel_gpu_top's headline number.
      utilPct = 0;
      for (const v of busyNs.values()) utilPct = Math.max(utilPct, (v / dtNs) * 100);
      for (const [cy, total] of cyc.values()) if (total > 0) utilPct = Math.max(utilPct, (cy / total) * 100);
      utilPct = Math.min(100, utilPct);
    }
    const base = `/sys/class/drm/${card}`;
    const freqMhz =
      num((await readText(`${base}/gt_cur_freq_mhz`)) ?? undefined) ??
      num((await readText(`${base}/device/tile0/gt0/freq0/act_freq`)) ?? undefined);
    const maxFreqMhz =
      num((await readText(`${base}/gt_RP0_freq_mhz`)) ?? undefined) ??
      num((await readText(`${base}/device/tile0/gt0/freq0/rp0_freq`)) ?? undefined);
    result.push({
      name: ((await pciName(pdev)) || `${driver === "xe" ? "Intel" : "Intel"} GPU (${pdev})`).slice(0, 200),
      utilPct,
      memUsedBytes: null,
      memTotalBytes: null,
      tempC: null,
      powerW: null,
      freqMhz,
      maxFreqMhz,
    });
  }
  return result;
}

// macOS sensors via macmon (brew install macmon): CPU/GPU temperature, power
// and GPU frequency without sudo. Optional — absent means those stay empty.
type MacmonData = { cpuTempC: number | null; gpuTempC: number | null; cpuPowerW: number | null; gpuPowerW: number | null; sysPowerW: number | null; gpuFreqMhz: number | null };
let macmonPath: string | null | undefined;
let macmonCheckedAt = 0;

async function findMacmon(): Promise<string | null> {
  if (macmonPath !== undefined && (macmonPath !== null || Date.now() - macmonCheckedAt < 5 * 60_000)) return macmonPath;
  macmonCheckedAt = Date.now();
  macmonPath = null;
  for (const candidate of ["macmon", "/opt/homebrew/bin/macmon", "/usr/local/bin/macmon"]) {
    if ((await run(candidate, ["--version"], 2000)) !== null) {
      macmonPath = candidate;
      break;
    }
  }
  return macmonPath;
}

async function readMacmon(): Promise<MacmonData | null> {
  const bin = await findMacmon();
  if (bin === null) return null;
  const out = await run(bin, ["pipe", "-s", "1", "-i", "400"], 5000);
  if (out === null) return null;
  try {
    const j = JSON.parse(out.trim().split("\n").pop()!) as Record<string, unknown>;
    const f = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const temp = (j.temp ?? {}) as Record<string, unknown>;
    const pos = (v: number | null) => (v !== null && v > 0 ? v : null); // macmon reports 0 when a sensor is missing
    return {
      cpuTempC: pos(f(temp.cpu_temp_avg)),
      gpuTempC: pos(f(temp.gpu_temp_avg)),
      cpuPowerW: f(j.cpu_power),
      gpuPowerW: f(j.gpu_power),
      sysPowerW: pos(f(j.sys_power)),
      gpuFreqMhz: f(j.gpu_freq_mhz) ?? f((j.gpu_usage as unknown[] | undefined)?.[0]),
    };
  } catch {
    return null;
  }
}

async function gpusApple(mm: MacmonData | null): Promise<GpuSample[]> {
  const out = await run("ioreg", ["-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"]);
  if (out === null) return [];
  const result: GpuSample[] = [];
  for (const block of out.split(/\n(?=\+-o )/)) {
    const util = num(/"Device Utilization %"=(\d+)/.exec(block)?.[1]);
    if (util === null) continue;
    const model = /"model" = "([^"]+)"/.exec(block)?.[1] ?? "Apple GPU";
    const inUse = num(/"In use system memory"=(\d+)/.exec(block)?.[1]);
    result.push({
      name: model.slice(0, 200),
      utilPct: util,
      memUsedBytes: inUse,
      memTotalBytes: null,
      tempC: mm?.gpuTempC ?? null,
      powerW: mm?.gpuPowerW ?? null,
      freqMhz: mm?.gpuFreqMhz ?? null,
      maxFreqMhz: null,
    });
  }
  return result;
}

async function gpus(mm: MacmonData | null): Promise<GpuSample[]> {
  if (platform === "darwin") return gpusApple(mm);
  if (platform === "linux" || platform === "win32") {
    const nv = await gpusNvidia();
    if (platform === "win32") return nv;
    const amd = await gpusAmdSysfs();
    return [...nv, ...amd, ...(await gpusDrmFdinfo(new Set(amd.length > 0 ? ["amdgpu"] : [])))];
  }
  return [];
}

// ---------- Sampler ----------

type Prev = { at: number; cpu: CpuTimes; counters: Counters };
let prev: Prev | null = null;

function rate(now: number | null, before: number | null, dtSec: number): number | null {
  if (now === null || before === null || dtSec <= 0) return null;
  const d = now - before;
  return d < 0 ? null : d / dtSec; // counter reset → skip one point
}

async function takeSample(signal: AbortSignal): Promise<MachineSample> {
  if (prev === null) {
    prev = { at: Date.now(), cpu: cpuTimes(), counters: await counters() };
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 700);
      signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    });
  }
  const at = Date.now();
  const cpu = cpuTimes();
  const macmon = platform === "darwin" ? readMacmon() : Promise.resolve(null);
  const [mem, disk, ctr, temp, mm, gpuList] = await Promise.all([
    memory(),
    diskUsage(),
    counters(),
    platform === "linux" ? cpuTempLinux() : Promise.resolve(null),
    macmon,
    macmon.then(gpus),
  ]);
  const dt = (at - prev.at) / 1000;
  const dTotal = cpu.total - prev.cpu.total;
  const dIdle = cpu.idle - prev.cpu.idle;
  const cpuPct = dTotal > 0 ? Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100)) : null;
  const sample: MachineSample = {
    ts: at,
    platform,
    arch: os.arch(),
    hostname: os.hostname().slice(0, 200),
    cpuModel: (os.cpus()[0]?.model ?? "unknown").trim().slice(0, 200),
    cpuCount: os.cpus().length,
    uptimeSec: os.uptime(),
    cpuPct,
    load1: platform === "win32" ? null : os.loadavg()[0]!,
    load5: platform === "win32" ? null : os.loadavg()[1]!,
    load15: platform === "win32" ? null : os.loadavg()[2]!,
    memUsedBytes: mem.used,
    memTotalBytes: mem.total,
    swapUsedBytes: mem.swapUsed,
    swapTotalBytes: mem.swapTotal,
    diskUsedBytes: disk?.used ?? null,
    diskTotalBytes: disk?.total ?? null,
    diskReadBps: rate(ctr.diskRead, prev.counters.diskRead, dt),
    diskWriteBps: rate(ctr.diskWrite, prev.counters.diskWrite, dt),
    netRxBps: rate(ctr.netRx, prev.counters.netRx, dt),
    netTxBps: rate(ctr.netTx, prev.counters.netTx, dt),
    cpuTempC: temp ?? mm?.cpuTempC ?? null,
    cpuPowerW: mm?.cpuPowerW ?? null,
    sysPowerW: mm?.sysPowerW ?? null,
    gpus: gpuList,
  };
  prev = { at, cpu, counters: ctr };
  return sample;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    sample: async (_input, context) => takeSample(context.signal),
  },
});
