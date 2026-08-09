import { describe, expect, it } from "vitest";
import type { GameClock } from "../types";
import { spectatorClockValue } from "./spectators";

const clocks: GameClock = {
  ivoryMs: 60_000,
  mahoganyMs: 90_000,
  running: "ivory",
  capturedAt: "2026-08-09T12:00:00.000Z",
  unlimited: false,
};

describe("reloj del espectador", () => {
  it("descuenta únicamente el reloj que está corriendo", () => {
    const now = new Date("2026-08-09T12:00:05.000Z").getTime();
    expect(spectatorClockValue(clocks, "active", "ivory", now)).toBe(55_000);
    expect(spectatorClockValue(clocks, "active", "mahogany", now)).toBe(90_000);
  });

  it("congela ambos relojes cuando la partida termina", () => {
    const now = new Date("2026-08-09T12:01:00.000Z").getTime();
    expect(spectatorClockValue(clocks, "completed", "ivory", now)).toBe(60_000);
  });

  it("nunca muestra tiempo negativo", () => {
    const now = new Date("2026-08-09T12:02:00.000Z").getTime();
    expect(spectatorClockValue(clocks, "active", "ivory", now)).toBe(0);
  });
});
