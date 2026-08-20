import { describe, expect, it } from "vitest";
import {
  DEFAULT_PIECE_COLOR_PREFERENCES,
  crownColorForPiece,
  normalizePieceColorPreferences,
  pieceColorPreferencesForSide,
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

  it("interpreta los colores compartidos desde la perspectiva de cada jugador", () => {
    const shared = { ivory: "blanca", mahogany: "negra" } as const;
    expect(pieceColorPreferencesForSide("ivory", shared)).toEqual({
      own: "blanca",
      opponent: "negra",
    });
    expect(pieceColorPreferencesForSide("mahogany", shared)).toEqual({
      own: "negra",
      opponent: "blanca",
    });
  });

  it("usa una corona blanca sobre fichas negras", () => {
    expect(crownColorForPiece("negra")).toBe("#ffffff");
    expect(crownColorForPiece("#121b17")).toBe("#ffffff");
  });

  it("usa una corona negra sobre fichas blancas", () => {
    expect(crownColorForPiece("blanca")).toBe("#000000");
    expect(crownColorForPiece("#edf2e8")).toBe("#000000");
  });

  it("conserva la corona amarilla para los demás colores configurables", () => {
    expect(crownColorForPiece("rojo")).toBe("#e8b85a");
  });
});
