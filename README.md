# gta6-twitch-ccu-forecast-01 — "Three Worlds" forecaster

Forecasts Grand Theft Auto VI's Twitch viewers for hours 2–24 of its
release day (2026-11-19 UTC) as five quantiles per hour, from the case
file alone. Entry for the make.fun bounty
`gta6-twitch-ccu-forecast-01` (pot $250, deadline 2026-11-19 01:00Z).

## How it works

1. **Anchor** on hour 1's print (`known.viewers`).
2. **Three worlds from the comparables.** Every comparable launch's
   release-day hourly curve is expressed as log-ratios to its own
   hour 1. A launch is one of three worlds: hype-stabil (flat),
   spike-then-collapse (hour 1 is the peak, then a fall), or rising
   (unlocks still rolling out, evening peak far above hour 1). The
   mixture of worlds lives in the distribution of these curves.
3. **Condition on hour-1 size.** The 12 comparables whose log hour-1
   is closest to the target's log hour-1 print form the reference
   class. A big hour 1 means most markets already unlocked (flat curve
   ahead); a small hour 1 means unlocks still coming (steep rise). On
   the practice comparables the median hour-19 ratio is ~1.3x for big
   hour-1 launches and ~11x for small ones, so unconditioned quantiles
   would be far too wide.
4. **Empirical quantiles.** Per hour, the five quantiles are the
   empirical quantiles (0.05/0.25/0.5/0.75/0.95) of the neighbours'
   log-ratios, mapped back through the hour-1 print. A small spread
   floor keeps the outer band honest when neighbours agree too much.
5. **Fallback.** With fewer than 5 usable comparable curves, it falls
   back to persistence with a widening log-spread, so a case always
   yields a valid forecast. A case file that cannot be read at all
   still gets a valid fallback output (all quantiles = 1) — never a
   crash, because an invalid case forfeits the prize.

## Determinism

No randomness, no clock, no network. Timestamps from the input are
parsed with pure arithmetic (no `Date` object). Two runs on the same
case write byte-identical output. Standard library only, Node 22.

## Run

```sh
# local practice run (kit's input/ holds p00.in..p03.in)
mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Backtest (practice cases, scored against SullyGnome hourly counts)

Measured 17 Nov 2026 with the kit's practice cases p00–p03 (ground
truth = each launch's own SullyGnome "Average viewers" for its release
day; the scorer reproduces the house baseline exactly: loss 0.3871,
coverage 0.783, pooled typical miss 82.7% — RULES states ~0.387 /
0.783 / ~82.8%).

| case | launch | hour-1 | loss | coverage90 | typical miss |
|------|--------|--------|------|-----------|--------------|
| p00 | Marvel's Wolverine | 23,357 | 0.3805 | 1.000 | 103.1% |
| p01 | Red Dead Redemption 2 | 116,550 | 0.2181 | 0.957 | 41.4% |
| p02 | God of War Ragnarök | 269,517 | 0.1452 | 0.957 | 31.1% |
| p03 | Marvel's Spider-Man 2 | 119,087 | 0.2084 | 0.783 | 33.9% |

**Mean loss 0.2381** (house baseline 0.3871 — 38% better), mean
coverage90 0.924 (honest ≈ 0.9). Tuning grid (K × spread floor):
K=8 → 0.2349, K=12 → 0.2415, K=16 → 0.2381, K=20 → 0.2477,
K=24 → 0.2466; the spread floor never bound on practice. K=16 was
chosen for the best worst case (max per-case loss 0.381), the best
coverage, and stabler tail quantiles with 42 comparables in the final.

Verified: two runs byte-identical; all outputs pass strict format
validation (23 rows, exact keys, quantiles in (0, 1e9], non-decreasing,
≤ 64 KiB); runtime ~80 ms/case (limit 8 s); missing hour-1 print,
garbage case file, and <5 comparables all still yield valid output
(fallback, never a crash); no `Date`, `Math.random`, or network in the
program (timestamps parsed with pure arithmetic).

Caveat: practice is 4 launches only. The final is one unseen launch
day (GTA VI, hour-1 print unknown until the deadline); the kNN
reference class adapts to its hour-1 size at runtime.

## Files

- `main.ts` — the forecaster (Node 22, stdlib only)
- `LICENSE` — MIT
