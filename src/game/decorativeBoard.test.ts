import { describe, expect, it } from "vitest";
import { decorativeBoardCells } from "./decorativeBoard";

describe("tablero decorativo de la portada", () => {
  const cells = decorativeBoardCells();

  it("genera una cuadrícula exacta de 10 por 10", () => {
    expect(cells).toHaveLength(100);
    for (let row = 0; row < 10; row += 1) {
      expect(cells.filter((cell) => cell.row === row)).toHaveLength(10);
    }
  });

  it("alterna las casillas también en las dos filas centrales", () => {
    const centralCells = cells.filter((cell) => cell.row === 4 || cell.row === 5);
    expect(centralCells.every((cell) => cell.piece === null)).toBe(true);
    for (const cell of centralCells) {
      expect(cell.dark).toBe((cell.row + cell.col) % 2 === 1);
    }
    expect(cells.find((cell) => cell.row === 4 && cell.col === 0)?.dark).toBe(false);
    expect(cells.find((cell) => cell.row === 5 && cell.col === 0)?.dark).toBe(true);
  });

  it("coloca veinte fichas por cada lado", () => {
    expect(cells.filter((cell) => cell.piece === "ivory")).toHaveLength(20);
    expect(cells.filter((cell) => cell.piece === "mahogany")).toHaveLength(20);
  });
});
