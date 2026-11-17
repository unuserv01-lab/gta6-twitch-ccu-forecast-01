// gta6-twitch-ccu-forecast-01 — "Three Worlds" forecaster.
// Forecasts GTA VI's Twitch viewers for hours 2-24 of release day
// (2026-11-19 UTC) as five quantiles per hour, from the case file alone.
//
// Method (all computed at runtime, deterministically, from the case):
//   1. Anchor on hour 1's print (known.viewers).
//   2. Take every comparable launch's release-day hourly curve (42 past
//      launches in the final case, 38 in a practice case) and express it
//      as log-ratios to its own hour 1. A launch's curve is one of three
//      worlds: hype-stabil (flat), spike-then-collapse (hour 1 is the
//      peak, then a fall), or rising (unlocks still rolling out, evening
//      peak far above hour 1). The mixture of worlds lives in the
//      distribution of these curves.
//   3. Condition on hour-1 SIZE: pick the K=12 comparables whose log
//      hour-1 is closest to the target's log hour-1 print. This matters:
//      a big hour 1 means most markets already unlocked (flat curve
//      ahead), a small hour 1 means unlocks still coming (steep rise).
//      On the practice comparables the median hour-19 ratio is ~1.3x
//      for big hour-1 launches and ~11x for small ones, so unconditioned
//      quantiles would be far too wide.
//   4. Per hour, the five quantiles are the empirical quantiles
//      (0.05/0.25/0.5/0.75/0.95, linear interpolation) of the neighbours'
//      log-ratios, mapped back through the hour-1 print. A small spread
//      floor keeps the outer band honest when neighbours agree too much.
//   5. Fallback: if fewer than 5 usable comparable curves exist, use
//      persistence with a widening log-spread (the house baseline's
//      shape), so the case always yields a valid forecast.
//
// Determinism: no randomness, no clock, no network, no environment
// except MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR. Timestamps from the
// input are parsed with pure arithmetic (no Date object). Two runs on
// the same case write byte-identical output. A case that fails to parse
// still gets a valid fallback forecast (all quantiles = 1), never a
// crash, because an invalid case forfeits the prize.
//
// Standard library only. Node 22. Run: node main.ts
// (MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out for local runs.)

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

// The five quantile levels the contest scores, in row order.
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
// Standard normal quantiles at those levels (fallback spread only).
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
// How many nearest (log hour-1) comparables form the reference class.
// Tuned on the 4 practice cases: K=16 gives the best worst case
// (max per-case loss 0.381) and coverage 0.924 at mean loss 0.238,
// essentially tied with K=8 (0.235) but with stabler tail quantiles
// and a better worst case; K=12/20/24 scored 0.242/0.248/0.247.
const K_NEIGHBORS = 16;
// Minimum usable comparable curves before the persistence fallback.
const MIN_CURVES = 5;
// Outer-band spread floor (log units): base + per-hour growth, so the
// band never claims more certainty than the horizon allows.
const MIN_WIDTH_BASE = 0.25;
const MIN_WIDTH_PER_HOUR = 0.02;
// Fallback log-spread per sqrt-hour (house baseline's shape).
const FALLBACK_SIGMA = 0.15;

interface KnownRow {
  hour: number;
  viewers: number;
}

interface ForecastRow {
  hour: number;
}

interface HourlyPoint {
  from: string;
  viewers: number;
}

interface Comparable {
  name: string;
  day_start: string;
  hourly: HourlyPoint[];
}

interface CaseFile {
  known?: KnownRow[];
  forecast?: ForecastRow[];
  comparables?: Comparable[];
}

interface Curve {
  name: string;
  v0: number;
  logr: number[]; // log(v[h] / v[1]) for h = 1..24
}

// Parse "2026-11-19T00:00:00Z" to epoch milliseconds with pure
// arithmetic (days-from-civil). No Date object: the program never
// reads the system clock.
function parseIsoMs(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(s);
  if (m === null) return NaN;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  const ss = Number(m[6]);
  const yy = mo <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (mo + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const days = era * 146097 + doe - 719468;
  return (((days * 24 + hh) * 60 + mm) * 60 + ss) * 1000;
}

// Linear-interpolation quantile of an ascending array (type-7).
function quantile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const idx = (n - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// One comparable's release-day curve as log-ratios to its hour 1.
// Returns null when the curve is incomplete or hour 1 is not positive.
function buildCurve(comp: Comparable): Curve | null {
  if (!comp || typeof comp.day_start !== "string" || !Array.isArray(comp.hourly)) return null;
  const start = parseIsoMs(comp.day_start);
  if (!Number.isFinite(start)) return null;
  const byTime = new Map<number, number>();
  for (const pt of comp.hourly) {
    if (!pt || typeof pt.from !== "string" || !Number.isFinite(pt.viewers)) continue;
    const t = parseIsoMs(pt.from);
    if (Number.isFinite(t)) byTime.set(t, pt.viewers);
  }
  const vals: number[] = [];
  for (let h = 1; h <= 24; h++) {
    const v = byTime.get(start + (h - 1) * 3600 * 1000);
    if (v === undefined || !Number.isFinite(v)) return null;
    vals.push(v);
  }
  const v0 = vals[0];
  if (!(v0 > 0)) return null;
  return { name: String(comp.name ?? ""), v0, logr: vals.map((v) => Math.log(Math.max(1, v) / v0)) };
}

// Persistence fallback: every hour at the hour-1 print with a spread
// that widens like a random walk in log space.
function fallbackRows(p1: number, hours: number[]): { hour: number; q: number[] }[] {
  return hours.map((h) => ({
    hour: h,
    q: Z.map((z) => round2(Math.min(1e9, Math.max(0.01, p1 * Math.exp(z * FALLBACK_SIGMA * Math.sqrt(h - 1)))))),
  }));
}

function forecastCase(c: CaseFile): { hour: number; q: number[] }[] {
  const known1 = Array.isArray(c.known) ? c.known.find((k) => k && k.hour === 1) : undefined;
  const p1 =
    known1 && Number.isFinite(known1.viewers) && known1.viewers > 0 ? known1.viewers : 1;
  const listed = Array.isArray(c.forecast)
    ? c.forecast.map((f) => f && f.hour).filter((h) => typeof h === "number" && h >= 2 && h <= 24)
    : [];
  const hours = listed.length === 23 ? [...listed].sort((a, b) => a - b) : Array.from({ length: 23 }, (_, i) => i + 2);

  const curves: Curve[] = [];
  if (Array.isArray(c.comparables)) {
    for (const comp of c.comparables) {
      const cv = buildCurve(comp);
      if (cv !== null) curves.push(cv);
    }
  }
  if (curves.length < MIN_CURVES) return fallbackRows(p1, hours);

  // Reference class: the K comparables whose log hour-1 is closest to
  // the target's log hour-1 print. Ties break by name, so the choice is
  // deterministic.
  const logP1 = Math.log(p1);
  const ranked = curves
    .map((cv) => ({ cv, dist: Math.abs(Math.log(cv.v0) - logP1) }))
    .sort((a, b) => a.dist - b.dist || (a.cv.name < b.cv.name ? -1 : a.cv.name > b.cv.name ? 1 : 0));
  const neighbors = ranked.slice(0, Math.min(K_NEIGHBORS, ranked.length)).map((r) => r.cv);

  const rows: { hour: number; q: number[] }[] = [];
  for (const h of hours) {
    const xs = neighbors.map((nb) => nb.logr[h - 1]).sort((a, b) => a - b);
    const qs = LEVELS.map((lv) => quantile(xs, lv));
    const med = qs[2];
    // Spread floor: widen the outer band symmetrically around the
    // median when the neighbours agree too tightly for the horizon.
    const minWidth = MIN_WIDTH_BASE + MIN_WIDTH_PER_HOUR * (h - 1);
    if (qs[4] - qs[0] < minWidth) {
      const half = minWidth / 2;
      qs[0] = med - half;
      qs[4] = med + half;
      qs[1] = Math.min(Math.max(qs[1], qs[0]), med);
      qs[3] = Math.max(Math.min(qs[3], qs[4]), med);
    }
    let out = qs.map((lq) => round2(p1 * Math.exp(lq)));
    out = out.map((v) => Math.min(1e9, Math.max(0.01, v)));
    for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1]);
    rows.push({ hour: h, q: out });
  }
  return rows;
}

// A valid fallback forecast for a case file that cannot be read at all.
function emergencyRows(): { hour: number; q: number[] }[] {
  return Array.from({ length: 23 }, (_, i) => ({ hour: i + 2, q: [1, 1, 1, 1, 1] }));
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith(".in")).sort();
for (const file of inputs) {
  const id = file.slice(0, -".in".length);
  let rows: { hour: number; q: number[] }[];
  try {
    const parsed = JSON.parse(readFileSync(join(INPUT_DIR, file), "utf8")) as CaseFile;
    rows = forecastCase(parsed);
  } catch {
    rows = emergencyRows();
  }
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours: rows })}\n`);
}
