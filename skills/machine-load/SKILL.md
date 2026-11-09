---
name: machine-load
description: Check current hardware load (CPU, RAM, swap, disk, disk IO, network, GPU, temperature) of every bb machine with `bb machine-load`. Use before starting heavy builds/tests to pick a less loaded machine, or when diagnosing slowness.
---

# Machine load

`bb machine-load` prints the latest sample for every enrolled bb machine
(the plugin polls each host every few seconds; default 5s).

- `bb machine-load` — human-readable summary per machine.
- `bb machine-load --json` — array of `{ hostId, name, status, lastError, latest }`,
  where `latest` has `cpuPct`, `load1/5/15`, `memUsedBytes/memTotalBytes`,
  `swapUsedBytes/swapTotalBytes`, `diskUsedBytes/diskTotalBytes`,
  `diskReadBps/diskWriteBps`, `netRxBps/netTxBps`, `cpuTempC`, `cpuPowerW`,
  `sysPowerW`, `gpus[]` (`utilPct`, memory, `tempC`, `powerW`, `freqMhz`).
  A null field means the machine cannot report it (e.g. macOS temperatures
  need `macmon` installed).

History and charts are in the **Machines** page in the bb sidebar.
Settings: `bb plugin config machine-load set intervalSec <2-300>` and
`retentionHours <1-720>` (default 168).
