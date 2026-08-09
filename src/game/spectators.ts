import type { GameClock, GameStatus, Side } from "../types";

export function spectatorClockValue(
  clocks: GameClock,
  status: GameStatus,
  side: Side,
  now = Date.now(),
) {
  const key = side === "ivory" ? "ivoryMs" : "mahoganyMs";
  const stored = Math.max(Number(clocks[key]) || 0, 0);
  if (status !== "active" || clocks.running !== side) return stored;
  const capturedAt = new Date(clocks.capturedAt).getTime();
  const elapsed = Number.isFinite(capturedAt) ? Math.max(now - capturedAt, 0) : 0;
  return Math.max(stored - elapsed, 0);
}
