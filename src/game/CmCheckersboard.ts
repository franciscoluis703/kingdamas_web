import type { BoardState, LegalMove, Piece, Position, Side } from "../types";
import {
  destination,
  findAppliedMove,
  getLegalMoves,
  playableNumber,
  sameBoard,
  samePosition,
} from "./engine";

interface BoardOptions {
  orientation: Side;
  playerSide: Side;
  pieceColors: Record<Side, string>;
  onMove: (move: LegalMove) => Promise<void> | void;
}

interface BoardUpdate {
  board: BoardState;
  currentPlayer: Side;
  enabled: boolean;
  lastMoveNotation?: string;
}

const cloneBoard = (board: BoardState): BoardState =>
  board.map((row) => row.map((piece) => (piece ? { ...piece } : null)));

/**
 * Adaptador 10×10 inspirado en el modelo responsive y de puntero de
 * cm-chessboard. La librería original fija sus coordenadas y SVG a 8×8;
 * este componente conserva la misma responsabilidad en una cuadrícula de
 * damas internacionales, sin mezclarla con las reglas del juego.
 */
export class CmCheckersboard {
  private board: BoardState = [];
  private selected: Position | null = null;
  private legalMoves: LegalMove[] = [];
  private currentPlayer: Side = "ivory";
  private enabled = false;
  private busy = false;
  private animating = false;
  private destroyed = false;
  private animationToken = 0;
  private pendingUpdate: BoardUpdate | null = null;
  private readonly activeAnimations = new Set<Animation>();
  private readonly squares: HTMLButtonElement[] = [];
  private readonly pointerEvent = "pointerdown";

  constructor(
    private readonly element: HTMLElement,
    private readonly options: BoardOptions,
  ) {
    this.element.classList.add("cm-checkersboard");
    this.element.setAttribute("role", "grid");
    this.element.setAttribute("aria-label", "Tablero de damas internacional de 10 por 10");
    this.element.addEventListener(this.pointerEvent, this.handlePointer);
    this.element.addEventListener("keydown", this.handleKeyboard);
    this.createSquares();
  }

  update(board: BoardState, currentPlayer: Side, enabled: boolean, lastMoveNotation?: string) {
    const update = { board, currentPlayer, enabled, lastMoveNotation };
    if (this.animating) {
      this.pendingUpdate = update;
      return;
    }
    this.applyUpdate(update);
  }

  private applyUpdate(update: BoardUpdate) {
    if (sameBoard(this.board, update.board)) {
      this.commitUpdate(update);
      return;
    }
    const move = this.board.length
      ? findAppliedMove(this.board, update.board, this.currentPlayer, update.lastMoveNotation)
      : null;
    if (move?.captures && this.canAnimate()) {
      this.startCaptureAnimation(update, move);
      return;
    }
    this.commitUpdate(update);
  }

  private commitUpdate(update: BoardUpdate) {
    this.board = update.board;
    this.currentPlayer = update.currentPlayer;
    this.enabled = update.enabled;
    this.legalMoves = update.enabled ? getLegalMoves(update.board, update.currentPlayer) : [];
    if (
      this.selected &&
      !this.legalMoves.some((move) => samePosition(move.from, this.selected!))
    ) {
      this.selected = null;
    }
    this.render();
  }

  setPieceColors(pieceColors: Record<Side, string>) {
    this.options.pieceColors = pieceColors;
    if (!this.animating) this.render();
  }

  destroy() {
    this.destroyed = true;
    this.animationToken += 1;
    this.activeAnimations.forEach((animation) => animation.cancel());
    this.activeAnimations.clear();
    this.element.closest(".board-shell")?.classList.remove("is-animating-capture");
    this.element.removeEventListener(this.pointerEvent, this.handlePointer);
    this.element.removeEventListener("keydown", this.handleKeyboard);
    this.squares.length = 0;
    this.element.replaceChildren();
  }

  private toActual(visualRow: number, visualCol: number): Position {
    const flipped = this.options.orientation === "ivory";
    return flipped
      ? { row: 9 - visualRow, col: 9 - visualCol }
      : { row: visualRow, col: visualCol };
  }

  private movesFrom(position: Position) {
    return this.legalMoves.filter((move) => samePosition(move.from, position));
  }

  private moveTo(position: Position) {
    return this.movesFrom(this.selected ?? { row: -1, col: -1 }).find((move) => {
      const end = destination(move);
      return end ? samePosition(end, position) : false;
    });
  }

  private select(position: Position) {
    if (!this.enabled || this.busy || this.animating) return;
    const move = this.moveTo(position);
    if (move) {
      this.busy = true;
      this.selected = null;
      this.render();
      Promise.resolve(this.options.onMove(move)).finally(() => {
        this.busy = false;
        this.render();
      });
      return;
    }
    const piece = this.board[position.row]?.[position.col];
    this.selected = piece?.player === this.options.playerSide && this.movesFrom(position).length
      ? position
      : null;
    this.render();
  }

  private handlePointer = (event: Event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-row][data-col]");
    if (!target) return;
    event.preventDefault();
    this.select({ row: Number(target.dataset.row), col: Number(target.dataset.col) });
  };

  private handleKeyboard = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-row][data-col]");
    if (!target) return;
    event.preventDefault();
    this.select({ row: Number(target.dataset.row), col: Number(target.dataset.col) });
  };

  private createSquares() {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 100; index += 1) {
      const square = document.createElement("button");
      square.type = "button";
      square.setAttribute("role", "gridcell");
      this.squares.push(square);
      fragment.append(square);
    }
    this.element.replaceChildren(fragment);
  }

  private render() {
    for (let visualRow = 0; visualRow < 10; visualRow += 1) {
      for (let visualCol = 0; visualCol < 10; visualCol += 1) {
        const square = this.squares[visualRow * 10 + visualCol];
        if (!square) continue;
        const { row, col } = this.toActual(visualRow, visualCol);
        const piece = this.board[row]?.[col] ?? null;
        const dark = (row + col) % 2 === 1;
        const isSelected = Boolean(this.selected && samePosition(this.selected, { row, col }));
        const destinationMove = this.moveTo({ row, col });
        const isDestination = Boolean(destinationMove);
        const selectedCaptureCount = isSelected
          ? Math.max(0, ...this.movesFrom({ row, col }).map((move) => move.captures))
          : 0;
        const canSelect = Boolean(
          this.enabled && piece?.player === this.options.playerSide && this.movesFrom({ row, col }).length,
        );
        square.className = [
          "board-square",
          dark ? "board-square--dark" : "board-square--light",
          isSelected ? "is-selected" : "",
          isDestination ? "is-destination" : "",
          canSelect ? "is-playable" : "",
        ].filter(Boolean).join(" ");
        square.dataset.row = String(row);
        square.dataset.col = String(col);
        const captureDescription = destinationMove?.captures
          ? `, destino que captura ${destinationMove.captures} ${destinationMove.captures === 1 ? "ficha" : "fichas"}`
          : "";
        square.setAttribute("aria-label", `${this.squareLabel(row, col, piece)}${captureDescription}`);
        square.tabIndex = dark ? 0 : -1;
        square.replaceChildren();

        if (dark) {
          const number = document.createElement("span");
          number.className = "square-number";
          number.textContent = String(playableNumber(row, col));
          square.append(number);
        }
        if (isDestination) {
          const marker = document.createElement("span");
          marker.className = `move-marker${destinationMove?.captures ? " move-marker--capture" : ""}`;
          if (destinationMove?.captures) marker.textContent = `×${destinationMove.captures}`;
          marker.setAttribute("aria-hidden", "true");
          square.append(marker);
        }
        if (piece) {
          square.append(this.createChecker(piece));
        }
        if (selectedCaptureCount > 0) {
          const captureBadge = document.createElement("span");
          captureBadge.className = "capture-count-badge";
          captureBadge.textContent = `×${selectedCaptureCount}`;
          captureBadge.setAttribute(
            "aria-label",
            `Esta jugada captura ${selectedCaptureCount} ${selectedCaptureCount === 1 ? "ficha" : "fichas"}`,
          );
          square.append(captureBadge);
        }
      }
    }
    this.element.classList.toggle("is-disabled", !this.enabled || this.animating);
    this.element.classList.toggle("is-animating-capture", this.animating);
    this.element.closest(".board-shell")?.classList.toggle("is-animating-capture", this.animating);
    this.element.setAttribute("aria-busy", String(this.busy || this.animating));
  }

  private createChecker(piece: Piece) {
    const checker = document.createElement("span");
    checker.className = `checker checker--${piece.player}${piece.king ? " is-king" : ""}`;
    checker.style.setProperty("--piece-color", this.safeColor(piece.player));
    checker.setAttribute("aria-hidden", "true");
    if (piece.king) checker.innerHTML = '<span class="checker-crown">♛</span>';
    return checker;
  }

  private canAnimate() {
    if (
      this.destroyed ||
      document.visibilityState === "hidden" ||
      typeof HTMLElement.prototype.animate !== "function"
    ) return false;
    return typeof window.matchMedia !== "function" ||
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  private startCaptureAnimation(update: BoardUpdate, move: LegalMove) {
    const token = ++this.animationToken;
    this.animating = true;
    this.enabled = false;
    this.selected = null;
    this.legalMoves = [];
    this.render();
    void this.animateCapture(move, token).then(
      () => this.completeCaptureAnimation(token, update),
      () => this.completeCaptureAnimation(token, update),
    );
  }

  private completeCaptureAnimation(token: number, update: BoardUpdate) {
    if (this.destroyed || token !== this.animationToken) return;
    let completedUpdate = update;
    let queuedUpdate = this.pendingUpdate;
    this.pendingUpdate = null;
    if (queuedUpdate && sameBoard(queuedUpdate.board, update.board)) {
      completedUpdate = queuedUpdate;
      queuedUpdate = null;
    }
    this.animating = false;
    this.commitUpdate(completedUpdate);
    if (queuedUpdate) this.applyUpdate(queuedUpdate);
  }

  private async animateCapture(move: LegalMove, token: number) {
    const movingPiece = this.board[move.from.row]?.[move.from.col];
    if (!movingPiece) return;
    const animatedBoard = cloneBoard(this.board);
    let current = move.from;
    const visited: Position[] = [move.from];
    const traveler = this.createChecker(movingPiece);
    traveler.classList.add("capture-traveler");
    this.placeTraveler(traveler, current);
    this.element.append(traveler);
    this.markCaptureRoute(visited, current);

    try {
      for (const step of move.steps) {
        if (this.destroyed || token !== this.animationToken) return;
        const start = this.visualCenter(current);
        const end = this.visualCenter(step.to);
        const distance = Math.max(
          Math.abs(step.to.row - current.row),
          Math.abs(step.to.col - current.col),
        );
        const duration = Math.min(320, 180 + distance * 18);
        const capturedSquare = step.captured ? this.squareAt(step.captured) : null;
        capturedSquare?.classList.add("is-capture-target");
        this.squareAt(step.to)?.classList.add("is-capture-landing");
        const capturedChecker = capturedSquare?.querySelector<HTMLElement>(".checker") ?? null;
        const animations = [traveler.animate([
          { left: `${start.left}%`, top: `${start.top}%`, transform: "translate3d(-50%, -50%, 0) scale(1)" },
          { left: `${(start.left + end.left) / 2}%`, top: `${(start.top + end.top) / 2}%`, transform: "translate3d(-50%, -50%, 0) scale(1.08)", offset: 0.5 },
          { left: `${end.left}%`, top: `${end.top}%`, transform: "translate3d(-50%, -50%, 0) scale(1)" },
        ], {
          duration,
          easing: "cubic-bezier(.22,.8,.3,1)",
          fill: "forwards",
        })];
        if (capturedChecker) {
          animations.push(capturedChecker.animate([
            { opacity: 1, transform: "translate3d(-50%, -50%, 0) scale(1)" },
            { opacity: 1, transform: "translate3d(-50%, -50%, 0) scale(1.08)", offset: 0.55 },
            { opacity: 0, transform: "translate3d(-50%, -50%, 0) scale(.55)" },
          ], {
            duration,
            easing: "ease-in",
            fill: "forwards",
          }));
        }
        await Promise.all(animations.map((animation) => this.settleAnimation(animation)));
        if (this.destroyed || token !== this.animationToken) return;

        animatedBoard[current.row]![current.col] = null;
        if (step.captured) animatedBoard[step.captured.row]![step.captured.col] = null;
        animatedBoard[step.to.row]![step.to.col] = { ...movingPiece };
        current = step.to;
        visited.push(current);
        this.board = animatedBoard;
        this.placeTraveler(traveler, current);
        this.render();
        this.markCaptureRoute(visited, current);
        await new Promise<void>((resolve) => window.setTimeout(resolve, 45));
      }
    } finally {
      traveler.remove();
    }
  }

  private async settleAnimation(animation: Animation) {
    this.activeAnimations.add(animation);
    try {
      await animation.finished;
    } catch {
      // La animación se cancela al abandonar la pantalla.
    } finally {
      this.activeAnimations.delete(animation);
    }
  }

  private visualCenter(position: Position) {
    const flipped = this.options.orientation === "ivory";
    const row = flipped ? 9 - position.row : position.row;
    const col = flipped ? 9 - position.col : position.col;
    return { left: (col + 0.5) * 10, top: (row + 0.5) * 10 };
  }

  private placeTraveler(traveler: HTMLElement, position: Position) {
    const center = this.visualCenter(position);
    traveler.style.left = `${center.left}%`;
    traveler.style.top = `${center.top}%`;
  }

  private squareAt(position: Position) {
    const flipped = this.options.orientation === "ivory";
    const visualRow = flipped ? 9 - position.row : position.row;
    const visualCol = flipped ? 9 - position.col : position.col;
    return this.squares[visualRow * 10 + visualCol] ?? null;
  }

  private markCaptureRoute(visited: Position[], current: Position) {
    visited.forEach((position) => this.squareAt(position)?.classList.add("is-capture-route"));
    this.squareAt(current)?.querySelector(".checker")?.classList.add("is-animation-source");
  }

  private safeColor(side: Side) {
    const colors: Record<string, string> = {
      negra: "#121b17",
      blanca: "#edf2e8",
      verde: "#23875c",
      azul: "#326bb5",
      rojo: "#b8493e",
      madera: "#9c6544",
      rosado: "#d8809a",
      dorado: "#d5a633",
    };
    const fallback = side === "ivory" ? colors.blanca! : colors.negra!;
    const value = this.options.pieceColors[side];
    if (/^#[0-9a-f]{6}$/i.test(value)) return value;
    return colors[value] ?? fallback;
  }

  private squareLabel(row: number, col: number, piece: BoardState[number][number]) {
    const number = playableNumber(row, col);
    if (!number) return "Casilla clara no jugable";
    if (!piece) return `Casilla ${number}, vacía`;
    const color = piece.player === "ivory" ? "marfil" : "caoba";
    return `Casilla ${number}, ${piece.king ? "dama" : "ficha"} ${color}`;
  }
}
