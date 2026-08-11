import { describe, expect, it } from "vitest";
import {
  DEFAULT_PIECE_COLOR_PREFERENCES,
  normalizePieceColorPreferences,
  pieceColorsFor,
} from "./pieceColorPreferences";

describe("preferencias de color de las fichas", () => {
  it("usa blanco y negro de forma predeterminada", () => {
    expect(normalizePieceColorPreferences(null)).toEqual(
      DEFAULT_PIECE_COLOR_PREFERENCES,
    );
  });

  it("nunca permite el mismo color para ambos jugadores", () => {
    const preferences = normalizePieceColorPreferences({
      own: "azul",
      opponent: "azul",
    });
    expect(preferences.own).toBe("azul");
    expect(preferences.opponent).not.toBe("azul");
  });

  it("mantiene la preferencia del usuario al cambiar de lado", () => {
    const preferences = { own: "rojo", opponent: "madera" } as const;
    expect(pieceColorsFor("ivory", preferences)).toEqual({
      ivory: "rojo",
      mahogany: "madera",
    });
    expect(pieceColorsFor("mahogany", preferences)).toEqual({
      ivory: "madera",
      mahogany: "rojo",
    });
  });
});
