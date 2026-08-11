import { createInitialBoard } from "./engine";

export interface DecorativeBoardCell {
  row: number;
  col: number;
  dark: boolean;
  piece: "ivory" | "mahogany" | null;
}

export function decorativeBoardCells(): DecorativeBoardCell[] {
  return createInitialBoard().flatMap((row, rowIndex) => (
    row.map((piece, colIndex) => ({
      row: rowIndex,
      col: colIndex,
      dark: (rowIndex + colIndex) % 2 === 1,
      piece: piece?.player ?? null,
    }))
  ));
}

export function decorativeBoardMarkup() {
  return decorativeBoardCells().map((cell) => (
    `<span class="mini-square ${cell.dark ? "is-dark" : ""}">${cell.piece ? `<i class="mini-piece ${cell.piece === "ivory" ? "is-ivory" : "is-mahogany"}"></i>` : ""}</span>`
  )).join("");
}
