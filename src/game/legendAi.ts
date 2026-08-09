import type { BoardState, LegalMove, Side } from "../types";
import { applyMove, countPieces, getLegalMoves, opponentOf } from "./engine";
import { legendByKey, type LegendDifficultyKey } from "./legends";

const KING_VALUE = 1.75;
const MOBILITY_WEIGHT = 0.035;
const ADVANCE_WEIGHT = 0.014;
const CENTER_WEIGHT = 0.012;
const WIN_SCORE = 10_000;

function evaluate(board: BoardState, player: Side) {
  const opponent = opponentOf(player);
  let score = 0;
  board.forEach((row, rowIndex) => {
    row.forEach((piece, colIndex) => {
      if (!piece) return;
      const sign = piece.player === player ? 1 : -1;
      score += sign * (piece.king ? KING_VALUE : 1);
      if (!piece.king) {
        const advance = piece.player === "ivory" ? rowIndex : 9 - rowIndex;
        score += sign * advance * ADVANCE_WEIGHT;
      }
      const centerDistance = Math.abs(4.5 - rowIndex) + Math.abs(4.5 - colIndex);
      score += sign * (9 - centerDistance) * CENTER_WEIGHT;
    });
  });
  score += (getLegalMoves(board, player).length - getLegalMoves(board, opponent).length) * MOBILITY_WEIGHT;
  return score;
}

function negamax(
  board: BoardState,
  player: Side,
  depth: number,
  alpha: number,
  beta: number,
  context: { nodes: number; nodeBudget: number },
): number {
  context.nodes += 1;
  const opponent = opponentOf(player);
  const counts = countPieces(board);
  if (!counts[player].total) return -WIN_SCORE - depth;
  if (!counts[opponent].total) return WIN_SCORE + depth;
  if (depth <= 0 || context.nodes >= context.nodeBudget) {
    return evaluate(board, player);
  }
  const moves = getLegalMoves(board, player);
  if (!moves.length) return -WIN_SCORE - depth;
  let best = -Infinity;
  const orderedMoves = [...moves].sort(
    (first, second) => tacticalValue(second) - tacticalValue(first),
  );
  for (const move of orderedMoves) {
    const score = -negamax(
      applyMove(board, move),
      opponent,
      depth - 1,
      -beta,
      -alpha,
      context,
    );
    best = Math.max(best, score);
    alpha = Math.max(alpha, score);
    if (alpha >= beta) break;
  }
  return best;
}

function tacticalValue(move: LegalMove) {
  return move.captures * 10 + move.capturedKings * 4;
}

export function chooseLegendMove(
  board: BoardState,
  player: Side,
  difficultyKey: LegendDifficultyKey = "coronaeterna",
): LegalMove | null {
  const moves = getLegalMoves(board, player);
  if (!moves.length) return null;
  if (moves.length === 1) return moves[0]!;
  const legend = legendByKey(difficultyKey) || legendByKey("coronaeterna")!;
  const configuredDepth = legend.ai.depth;
  const depth = moves.length > 14
    ? Math.max(0, configuredDepth - 1)
    : configuredDepth;
  const opponent = opponentOf(player);
  let alpha = -Infinity;
  const scored = moves.map((move) => {
    const context = {
      nodes: 0,
      nodeBudget: Math.max(
        50,
        Math.floor(legend.ai.nodeBudget / moves.length),
      ),
    };
    const score = depth === 0
      ? evaluate(applyMove(board, move), player)
      : -negamax(
          applyMove(board, move),
          opponent,
          depth - 1,
          -Infinity,
          -alpha,
          context,
        );
    alpha = Math.max(alpha, score);
    return { move, score: score + tacticalValue(move) * 0.001 };
  });
  scored.sort((first, second) => second.score - first.score);
  const candidateCount = Math.min(legend.ai.candidatePool, scored.length);
  const candidateIndex = candidateCount === 1
    ? 0
    : Math.floor(Math.random() * candidateCount);
  return scored[candidateIndex]!.move;
}
