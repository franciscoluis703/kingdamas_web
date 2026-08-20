import type { BoardState, LegalMove, MoveStep, Piece, Position, Side } from "../types";

export const AUTOMATIC_DRAW_MAX_PIECES = 2;
export const AUTOMATIC_DRAW_MOVES_WITHOUT_CAPTURE = 10;

const DIRECTIONS = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
] as const;

const inside = (row: number, col: number, size: number) =>
  row >= 0 && row < size && col >= 0 && col < size;

const clone = (board: BoardState): BoardState =>
  board.map((row) => row.map((piece) => (piece ? { ...piece } : null)));

export const opponentOf = (player: Side): Side =>
  player === "ivory" ? "mahogany" : "ivory";

export function createInitialBoard(): BoardState {
  const board: BoardState = Array.from({ length: 10 }, () => Array<Piece | null>(10).fill(null));
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
}

function simpleMoves(board: BoardState, row: number, col: number, piece: Piece) {
  const moves: LegalMove[] = [];
  const directions = piece.king
    ? DIRECTIONS
    : piece.player === "ivory"
      ? ([DIRECTIONS[2], DIRECTIONS[3]] as const)
      : ([DIRECTIONS[0], DIRECTIONS[1]] as const);

  for (const [dr, dc] of directions) {
    let toRow = row + dr;
    let toCol = col + dc;
    while (inside(toRow, toCol, board.length) && !board[toRow]?.[toCol]) {
      moves.push({
        from: { row, col },
        steps: [{ to: { row: toRow, col: toCol }, captured: null }],
        captures: 0,
        capturedKings: 0,
      });
      if (!piece.king) break;
      toRow += dr;
      toCol += dc;
    }
  }
  return moves;
}

interface CaptureOption {
  to: Position;
  captured: Position & { king: boolean };
  direction: { dr: number; dc: number };
}

function immediateCaptures(
  board: BoardState,
  row: number,
  col: number,
  piece: Piece,
  previousDirection?: { dr: number; dc: number },
): CaptureOption[] {
  const captures: CaptureOption[] = [];

  if (!piece.king) {
    for (const [dr, dc] of DIRECTIONS) {
      const enemyRow = row + dr;
      const enemyCol = col + dc;
      const landingRow = row + dr * 2;
      const landingCol = col + dc * 2;
      const target = board[enemyRow]?.[enemyCol];
      if (
        target &&
        target.player !== piece.player &&
        inside(landingRow, landingCol, board.length) &&
        !board[landingRow]?.[landingCol]
      ) {
        captures.push({
          to: { row: landingRow, col: landingCol },
          captured: { row: enemyRow, col: enemyCol, king: target.king },
          direction: { dr, dc },
        });
      }
    }
    return captures;
  }

  for (const [dr, dc] of DIRECTIONS) {
    if (previousDirection && dr === -previousDirection.dr && dc === -previousDirection.dc) {
      continue;
    }
    let scanRow = row + dr;
    let scanCol = col + dc;
    let target: { row: number; col: number; piece: Piece } | null = null;
    while (inside(scanRow, scanCol, board.length)) {
      const cell = board[scanRow]?.[scanCol];
      if (!cell) {
        if (target) {
          captures.push({
            to: { row: scanRow, col: scanCol },
            captured: { row: target.row, col: target.col, king: target.piece.king },
            direction: { dr, dc },
          });
        }
        scanRow += dr;
        scanCol += dc;
        continue;
      }
      if (cell.player === piece.player || target) break;
      target = { row: scanRow, col: scanCol, piece: cell };
      scanRow += dr;
      scanCol += dc;
    }
  }
  return captures;
}

function captureSequences(
  board: BoardState,
  origin: Position,
  row: number,
  col: number,
  piece: Piece,
  steps: MoveStep[] = [],
  previousDirection?: { dr: number; dc: number },
): LegalMove[] {
  const options = immediateCaptures(board, row, col, piece, previousDirection);
  if (!options.length) {
    return steps.length
      ? [{
          from: origin,
          steps,
          captures: steps.length,
          capturedKings: steps.filter((step) => step.captured?.king).length,
        }]
      : [];
  }

  return options.flatMap((option) => {
    const next = clone(board);
    if (next[row]) next[row]![col] = null;
    if (next[option.captured.row]) next[option.captured.row]![option.captured.col] = null;
    if (next[option.to.row]) next[option.to.row]![option.to.col] = { ...piece };
    return captureSequences(
      next,
      origin,
      option.to.row,
      option.to.col,
      piece,
      [...steps, { to: option.to, captured: option.captured }],
      option.direction,
    );
  });
}

export function getLegalMoves(board: BoardState, player: Side): LegalMove[] {
  const captures: LegalMove[] = [];
  const moves: LegalMove[] = [];
  board.forEach((row, rowIndex) => {
    row.forEach((piece, colIndex) => {
      if (piece?.player !== player) return;
      captures.push(
        ...captureSequences(board, { row: rowIndex, col: colIndex }, rowIndex, colIndex, piece),
      );
      moves.push(...simpleMoves(board, rowIndex, colIndex, piece));
    });
  });
  if (!captures.length) return moves;
  const maxCaptured = Math.max(...captures.map((move) => move.captures));
  const byPieces = captures.filter((move) => move.captures === maxCaptured);
  const maxKings = Math.max(...byPieces.map((move) => move.capturedKings));
  return byPieces.filter((move) => move.capturedKings === maxKings);
}

export const samePosition = (a: Position, b: Position) =>
  a.row === b.row && a.col === b.col;

export const destination = (move: LegalMove) =>
  move.steps[move.steps.length - 1]?.to;

export const playableNumber = (row: number, col: number) =>
  (row + col) % 2 === 1 ? row * 5 + Math.floor(col / 2) + 1 : null;

export function applyMove(board: BoardState, move: LegalMove): BoardState {
  const next = clone(board);
  const source = next[move.from.row]?.[move.from.col];
  if (!source) return next;
  const movingPiece = { ...source };
  next[move.from.row]![move.from.col] = null;
  for (const step of move.steps) {
    if (step.captured) next[step.captured.row]![step.captured.col] = null;
  }
  const target = destination(move);
  if (!target) return next;
  if (
    !movingPiece.king &&
    ((movingPiece.player === "ivory" && target.row === 9) ||
      (movingPiece.player === "mahogany" && target.row === 0))
  ) {
    movingPiece.king = true;
  }
  next[target.row]![target.col] = movingPiece;
  return next;
}

export function sameBoard(a: BoardState, b: BoardState) {
  if (a.length !== b.length) return false;
  return a.every((row, rowIndex) => {
    const otherRow = b[rowIndex];
    if (!otherRow || row.length !== otherRow.length) return false;
    return row.every((piece, colIndex) => {
      const other = otherRow[colIndex] ?? null;
      return piece?.player === other?.player && Boolean(piece?.king) === Boolean(other?.king);
    });
  });
}

export function findAppliedMove(
  board: BoardState,
  next: BoardState,
  player: Side,
  notation?: string,
) {
  const matchingMoves = getLegalMoves(board, player)
    .filter((move) => sameBoard(applyMove(board, move), next));
  return matchingMoves.find((move) => !notation || moveNotation(move) === notation) ??
    matchingMoves[0] ??
    null;
}

export function countPieces(board: BoardState) {
  const counts: Record<Side, { total: number; kings: number }> = {
    ivory: { total: 0, kings: 0 },
    mahogany: { total: 0, kings: 0 },
  };
  board.flat().forEach((piece) => {
    if (!piece) return;
    counts[piece.player].total += 1;
    if (piece.king) counts[piece.player].kings += 1;
  });
  return counts;
}

export function countMovesWithoutCapture(moves: Array<{ captures?: number }> = []) {
  let count = 0;
  for (let index = moves.length - 1; index >= 0; index -= 1) {
    if (Number(moves[index]?.captures) > 0) break;
    count += 1;
  }
  return count;
}

export function getWinner(
  board: BoardState,
  nextPlayer: Side,
  moves: Array<{ captures?: number }> = [],
): Side | "draw" | null {
  const counts = countPieces(board);
  if (!counts.ivory.total) return "mahogany";
  if (!counts.mahogany.total) return "ivory";
  if (!getLegalMoves(board, nextPlayer).length) return opponentOf(nextPlayer);
  if (
    counts.ivory.total <= AUTOMATIC_DRAW_MAX_PIECES &&
    counts.mahogany.total <= AUTOMATIC_DRAW_MAX_PIECES &&
    countMovesWithoutCapture(moves) >= AUTOMATIC_DRAW_MOVES_WITHOUT_CAPTURE
  ) {
    return "draw";
  }
  return null;
}

export function moveNotation(move: LegalMove) {
  const separator = move.captures ? "×" : "–";
  return [
    playableNumber(move.from.row, move.from.col),
    ...move.steps.map((step) => playableNumber(step.to.row, step.to.col)),
  ].join(separator);
}
