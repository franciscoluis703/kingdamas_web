import { describe, expect, it } from "vitest";
import type { BoardState, Piece } from "../types";
import { applyMove, countMovesWithoutCapture, destination, findAppliedMove, getLegalMoves, getWinner, playableNumber } from "./engine";
import { chooseLegendMove } from "./legendAi";
import { LEGENDS } from "./legends";

const emptyBoard = (): BoardState =>
  Array.from({ length: 10 }, () => Array<Piece | null>(10).fill(null));

const initialBoard = (): BoardState => {
  const board = emptyBoard();
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 10; col += 1) {
      if ((row + col) % 2 === 1) board[row]![col] = { player: "ivory", king: false };
    }
  }
  for (let row = 6; row < 10; row += 1) {
    for (let col = 0; col < 10; col += 1) {
      if ((row + col) % 2 === 1) board[row]![col] = { player: "mahogany", king: false };
    }
  }
  return board;
};

describe("motor 10×10 del cliente", () => {
  it("calcula las nueve jugadas iniciales de marfil", () => {
    expect(getLegalMoves(initialBoard(), "ivory")).toHaveLength(9);
  });

  it("hace obligatoria una captura disponible", () => {
    const board = emptyBoard();
    board[4]![3] = { player: "ivory", king: false };
    board[5]![4] = { player: "mahogany", king: false };
    const moves = getLegalMoves(board, "ivory");

    expect(moves).toHaveLength(1);
    expect(moves[0]?.captures).toBe(1);
    expect(destination(moves[0]!)).toEqual({ row: 6, col: 5 });
  });

  it("prioriza la secuencia que captura más fichas", () => {
    const board = emptyBoard();
    board[2]![1] = { player: "ivory", king: false };
    board[3]![2] = { player: "mahogany", king: false };
    board[5]![4] = { player: "mahogany", king: false };
    board[2]![7] = { player: "ivory", king: false };
    board[3]![8] = { player: "mahogany", king: false };

    const moves = getLegalMoves(board, "ivory");
    expect(moves.every((move) => move.captures === 2)).toBe(true);
    expect(moves.every((move) => move.from.col === 1)).toBe(true);
  });

  it("reconstruye el recorrido completo de una captura ya aplicada", () => {
    const board = emptyBoard();
    board[2]![1] = { player: "ivory", king: false };
    board[3]![2] = { player: "mahogany", king: false };
    board[5]![4] = { player: "mahogany", king: false };
    const move = getLegalMoves(board, "ivory")[0]!;

    expect(findAppliedMove(board, applyMove(board, move), "ivory")).toEqual(move);
    expect(move.steps.map((step) => step.to)).toEqual([
      { row: 4, col: 3 },
      { row: 6, col: 5 },
    ]);
  });

  it("permite que una dama se desplace por toda la diagonal", () => {
    const board = emptyBoard();
    board[5]![4] = { player: "ivory", king: true };
    expect(getLegalMoves(board, "ivory")).toHaveLength(17);
  });

  it("numera las 50 casillas jugables", () => {
    expect(playableNumber(0, 1)).toBe(1);
    expect(playableNumber(9, 8)).toBe(50);
    expect(playableNumber(0, 0)).toBeNull();
  });

  it("declara tablas tras 10 jugadas sin captura cuando ambos tienen menos de 3 fichas", () => {
    const board = emptyBoard();
    board[2]![1] = { player: "ivory", king: false };
    board[2]![5] = { player: "ivory", king: false };
    board[7]![0] = { player: "mahogany", king: false };
    board[7]![4] = { player: "mahogany", king: false };
    const moves = Array.from({ length: 10 }, () => ({ captures: 0 }));

    expect(getWinner(board, "ivory", moves)).toBe("draw");
  });

  it("mantiene activa la partida antes de completar 10 jugadas sin captura", () => {
    const board = emptyBoard();
    board[2]![1] = { player: "ivory", king: false };
    board[2]![5] = { player: "ivory", king: false };
    board[7]![0] = { player: "mahogany", king: false };
    board[7]![4] = { player: "mahogany", king: false };
    const moves = Array.from({ length: 9 }, () => ({ captures: 0 }));

    expect(getWinner(board, "ivory", moves)).toBeNull();
  });

  it("no declara tablas si alguno conserva 3 fichas", () => {
    const board = emptyBoard();
    board[2]![1] = { player: "ivory", king: false };
    board[2]![3] = { player: "ivory", king: false };
    board[2]![5] = { player: "ivory", king: false };
    board[7]![0] = { player: "mahogany", king: false };
    board[7]![4] = { player: "mahogany", king: false };
    const moves = Array.from({ length: 10 }, () => ({ captures: 0 }));

    expect(getWinner(board, "ivory", moves)).toBeNull();
  });

  it("reinicia el conteo de jugadas cuando ocurre una captura", () => {
    const moves = [
      ...Array.from({ length: 10 }, () => ({ captures: 0 })),
      { captures: 1 },
      ...Array.from({ length: 4 }, () => ({ captures: 0 })),
    ];

    expect(countMovesWithoutCapture(moves)).toBe(4);
  });

  it("prioriza la victoria si un jugador ya no tiene fichas", () => {
    const board = emptyBoard();
    board[7]![0] = { player: "mahogany", king: false };

    expect(getWinner(board, "ivory")).toBe("mahogany");
  });

  it("cada leyenda siempre elige una jugada legal", () => {
    const board = initialBoard();
    const legalMoves = getLegalMoves(board, "mahogany");
    for (const legend of LEGENDS) {
      const selected = chooseLegendMove(board, "mahogany", legend.key);
      expect(selected).not.toBeNull();
      expect(legalMoves).toContainEqual(selected);
    }
  }, 20_000);

  it("ordena las leyendas de menor a mayor dificultad", () => {
    expect(LEGENDS).toHaveLength(25);
    expect(new Set(LEGENDS.map((legend) => legend.key))).toHaveProperty("size", 25);
    expect(LEGENDS.map((legend) => legend.key)).toEqual([
      "facil", "aprendiz", "normal", "competente", "avanzado",
      "veterano", "experto", "maestro", "imposible", "sobrehumano",
      "implacable", "titan", "mitico", "legendario", "trascendental",
      "sobrenatural", "insuperable", "divino", "absoluto", "coronaeterna",
      "behemoth", "gogmagog", "amarok", "charon", "thanatos",
    ]);
    expect(new Set(LEGENDS.map((legend) => legend.portrait))).toHaveProperty("size", 25);
    expect(LEGENDS.every((legend) => legend.portrait.endsWith(`${legend.key}.avif`))).toBe(true);
    for (let index = 1; index < LEGENDS.length; index += 1) {
      expect(LEGENDS[index]!.level).toBe(index + 1);
      expect(LEGENDS[index]!.rating).toBeGreaterThan(LEGENDS[index - 1]!.rating);
      expect(LEGENDS[index]!.ai.depth).toBeGreaterThanOrEqual(LEGENDS[index - 1]!.ai.depth);
      expect(LEGENDS[index]!.ai.nodeBudget).toBeGreaterThan(LEGENDS[index - 1]!.ai.nodeBudget);
    }
    expect(LEGENDS.at(-1)?.difficulty).toBe("Muy imposible");
    expect(LEGENDS.at(-1)?.ai.candidatePool).toBe(1);
  });
});
