# SSE Payload Reference

Neuralwatt's streaming API emits SSE comment lines (prefix `: `) that the OpenAI SDK discards. Our custom `streamSimple` handler tees the response body to capture them. These payloads are stored verbatim in each JSONL entry under `EnergyEvent` and are the source of truth for carbon/grid replay — future upstream fields flow through without code changes.

## Payload Types

### `: energy`

Emitted once per request after the last data chunk. Contains energy consumption and carbon attribution.

```jsonc
{
  // Energy
  "energy_joules": 20.44,
  "energy_kwh": 5.679e-6,
  "avg_power_watts": 4087.0,
  "duration_seconds": 1.479,

  // Attribution
  "attribution_method": "prorated_token_pool_weighted_multi_gpu_8",
  "attribution_ratio": 0.0034,

  // Carbon
  "carbon_g_co2eq": 0.0002726,
  "grid_carbon_intensity_gco2perkwhr": 48.0,
  "grid_id": "FI",
  "carbon_source": "agent_cache",
}
```

> Note: the live API may also include other nested objects (e.g. memory/context-reuse metadata) in the `: energy` payload. This fork parses energy, cost, and carbon/grid fields only; any extra nested objects are still persisted verbatim inside `sse_energy_raw` but are no longer read or displayed.

### `: cost`

Emitted once per request after the last data chunk. Contains billing and quota information.

```jsonc
{
  "request_cost_usd": 2.8e-5,
  "cache_savings_usd": 0.0,
  "allowance_remaining_usd": 79.623536,
  "budget_remaining_usd": 79.623536,
}
```

## JSONL Storage

Each `turn_end` writes a `neuralwatt-energy` custom entry to the session JSONL:

```jsonc
{
  "type": "custom",
  "customType": "neuralwatt-energy",
  "data": {
    // First-class fields (used for cumulative replay)
    "energy_joules": 20.44,
    "cost_usd": 2.8e-5,

    // Verbatim SSE payloads (source of truth for carbon/grid replay)
    "sse_energy_raw": {/* : energy payload above */},
    "sse_cost_raw": {/* : cost payload above */},
  },
}
```

## Replay Semantics

| Field                                                                  | Replay strategy                                                       | Source           |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------- |
| `energy_joules`                                                        | **Cumulative** (sum across entries)                                   | First-class      |
| `cost_usd`                                                             | **Cumulative** (sum across entries)                                   | First-class      |
| Carbon (`carbon_g_co2eq`)                                              | **Cumulative** (sum across entries — like energy)                     | `sse_energy_raw` |
| Grid (`grid_id`, `grid_carbon_intensity_gco2perkwhr`, `carbon_source`) | **Latest-wins** (last entry in branch — the fleet routes per-request) | `sse_energy_raw` |

Energy and cost accumulate because they represent real resource consumption. Carbon accumulates the same way; grid_id/intensity are point-in-time snapshots — the last value in a branch is the "current" grid.

## Adding New Upstream Fields

No code changes needed in either `pi-neuralwatt-provider` or `pi-tps-web`. The raw SSE payloads are persisted verbatim and replay reads from them directly. New fields in `: energy` or `: cost` comments automatically appear in `sse_energy_raw` and `sse_cost_raw` respectively.

To _display_ a new field, update `buildEnergyText` in `index.ts`. To _surface_ it in pi-tps-web, read from `EnergyPayload.sse_energy_raw` / `sse_cost_raw`.

> Other SSE comment prefixes (e.g. `: mcr-session`, emitted by memory/context-reuse model variants) are silently ignored by `readEnergyFromTee()` — only `: energy` and `: cost` are parsed. MCR/context-reuse model variants (ids ending in `-long`) are additionally filtered out by `transformApiModel()`, so they never reach the model picker.
