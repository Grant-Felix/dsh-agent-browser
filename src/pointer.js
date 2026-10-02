/**
 * One human-pointer motion model.
 *
 * The planning lives here so that "human-like" cannot drift into several
 * definitions; a backend only decides how to deliver the samples.
 */

/**
 * Plan a hand-like path between two points.
 *
 * The shape comes from what is known about human pointing:
 * - **minimum-jerk velocity** (`10t³ - 15t⁴ + 6t⁵`): slow to start, fast in the
 *   middle, slow to stop. Constant speed is the giveaway a scripted cursor has.
 * - **duration grows with distance but sublinearly** (Fitts' law), so short hops
 *   stay snappy instead of taking a fixed time.
 * - **lateral bow**: real paths are arcs, not straight lines.
 * - **tremor**: a low-frequency oscillation plus white noise, amplitude from
 *   `jitter`, fading as the pointer settles.
 * - **overshoot and correction**: with a probability that rises with distance,
 *   the hand passes the target and comes back.
 *
 * @param from - `{ x, y }` where the pointer is now.
 * @param to - `{ x, y }` the target; the last sample is exactly this.
 * @param options - `model` ('human' | 'linear'), `speedPxPerSec`, `jitter`.
 * @returns `{ points, durationMs }`, each point `{ x, y, delay }`.
 */
export function planPath(from, to, { model = 'human', speedPxPerSec = 900, jitter = 1 } = {}) {
  if (model === 'linear' || !from) {
    return { points: [{ x: to.x, y: to.y, delay: 0 }], durationMs: 0 };
  }
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const speed = Math.max(120, Number(speedPxPerSec) || 900);
  const durationMs = Math.min(1500, Math.max(70, ((distance / speed) * 1000) * (0.85 + Math.random() * 0.4)));
  const steps = Math.max(3, Math.min(48, Math.round(durationMs / 12)));
  const bow = (Math.random() < 0.5 ? -1 : 1) * Math.min(70, distance * (0.05 + Math.random() * 0.12));
  const tremorAmplitude = Math.max(0, Number(jitter ?? 1)) * 1.7;
  const tremorHz = 7 + Math.random() * 6;
  const phase = Math.random() * Math.PI * 2;
  const normalX = -dy / (distance || 1);
  const normalY = dx / (distance || 1);
  const points = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const s = 10 * t ** 3 - 15 * t ** 4 + 6 * t ** 5;
    const bend = Math.sin(Math.PI * s) * bow;
    // Tremor fades near the target: a settling hand is steadier than a moving one.
    const settle = 1 - Math.abs(0.5 - t) * 1.2;
    const tremor = Math.sin(2 * Math.PI * tremorHz * t + phase) * tremorAmplitude * Math.max(0.15, settle);
    points.push({
      x: Math.round(from.x + dx * s + normalX * (bend + tremor) + (Math.random() - 0.5) * tremorAmplitude),
      y: Math.round(from.y + dy * s + normalY * (bend + tremor) + (Math.random() - 0.5) * tremorAmplitude),
      delay: durationMs / steps,
    });
  }
  if (distance > 120 && Math.random() < 0.35) {
    const over = 0.03 + Math.random() * 0.05;
    points.push({ x: Math.round(to.x + dx * over), y: Math.round(to.y + dy * over), delay: 16 });
    points.push({ x: Math.round(to.x - dx * over * 0.4), y: Math.round(to.y - dy * over * 0.4), delay: 16 });
  }
  points.push({ x: to.x, y: to.y, delay: 10 });
  return { points, durationMs };
}

/** Jittered delay helper, shared so both backends pause the same way. */
export function pause(base, spread = 0) {
  return new Promise((resolve) => setTimeout(resolve, base + Math.random() * spread));
}
