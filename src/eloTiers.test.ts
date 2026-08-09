import { describe, expect, it } from "vitest";
import { eloTier } from "./eloTiers";

describe("rangos Elo Damas", () => {
  it.each([
    [0, "Aprendiz"],
    [699, "Aprendiz"],
    [700, "Jugador"],
    [999, "Jugador"],
    [1000, "Experto"],
    [1199, "Experto"],
    [1200, "Candidato a Maestro"],
    [1399, "Candidato a Maestro"],
    [1400, "Maestro"],
    [1599, "Maestro"],
    [1600, "Maestro Superior"],
    [1799, "Maestro Superior"],
    [1800, "Maestro Élite"],
    [1999, "Maestro Élite"],
    [2000, "Gran Maestro"],
    [2199, "Gran Maestro"],
    [2200, "Gran Maestro Supremo"],
    [3000, "Gran Maestro Supremo"],
  ])("asigna %i a %s", (rating, expected) => {
    expect(eloTier(rating)).toBe(expected);
  });
});
