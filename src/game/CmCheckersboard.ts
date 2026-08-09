import { POINTER_EVENTS } from "cm-chessboard";
import type { BoardState, LegalMove, Position, Side } from "../types";
import { destination, getLegalMoves, playableNumber, samePosition } from "./engine";

interface BoardOptions {
  orientation: Side;
  playerSide: Side;
  pieceColors: Record<Side, string>;
  onMove: (move: LegalMove) => Promise<void> | void;
}

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
  private enabled = false;
  private busy = false;
  private readonly pointerEvent = POINTER_EVENTS.pointerdown || "pointerdown";

  constructor(
    private readonly element: HTMLElement,
    private readonly options: BoardOptions,
  ) {
    this.element.classList.add("cm-checkersboard");
    this.element.setAttribute("role", "grid");
    this.element.setAttribute("aria-label", "Tablero de damas internacional de 10 por 10");
    this.element.addEventListener(this.pointerEvent, this.handlePointer);
    this.element.addEventListener("keydown", this.handleKeyboard);
  }

  update(board: BoardState, currentPlayer: Side, enabled: boolean) {
    this.board = board;
    this.enabled = enabled;
    this.legalMoves = enabled ? getLegalMoves(board, currentPlayer) : [];
    if (
      this.selected &&
      !this.legalMoves.some((move) => samePosition(move.from, this.selected!))
    ) {
      this.selected = null;
    }
    this.render();
  }

  destroy() {
    this.element.removeEventListener(this.pointerEvent, this.handlePointer);
    this.element.removeEventListener("keydown", this.handleKeyboard);
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
    if (!this.enabled || this.busy) return;
    const move = this.moveTo(position);
    if (move) {
      this.busy = true;
      this.selected = null;
      this.render();
      Promise.resolve(this.options.onMove(move)).finally(() => {
        this.busy = false;
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

  private render() {
    const fragment = document.createDocumentFragment();
    for (let visualRow = 0; visualRow < 10; visualRow += 1) {
      for (let visualCol = 0; visualCol < 10; visualCol += 1) {
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
        const square = document.createElement("button");
        square.type = "button";
        square.className = [
          "board-square",
          dark ? "board-square--dark" : "board-square--light",
          isSelected ? "is-selected" : "",
          isDestination ? "is-destination" : "",
          canSelect ? "is-playable" : "",
        ].filter(Boolean).join(" ");
        square.dataset.row = String(row);
        square.dataset.col = String(col);
        square.setAttribute("role", "gridcell");
        const captureDescription = destinationMove?.captures
          ? `, destino que captura ${destinationMove.captures} ${destinationMove.captures === 1 ? "ficha" : "fichas"}`
          : "";
        square.setAttribute("aria-label", `${this.squareLabel(row, col, piece)}${captureDescription}`);
        square.tabIndex = dark ? 0 : -1;

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
          const checker = document.createElement("span");
          checker.className = `checker checker--${piece.player}${piece.king ? " is-king" : ""}`;
          checker.style.setProperty("--piece-color", this.safeColor(piece.player));
          checker.setAttribute("aria-hidden", "true");
          if (piece.king) checker.innerHTML = '<span class="checker-crown">♛</span>';
          square.append(checker);
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
        fragment.append(square);
      }
    }
    this.element.replaceChildren(fragment);
    this.element.classList.toggle("is-disabled", !this.enabled);
    this.element.setAttribute("aria-busy", String(this.busy));
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
    const fallback = side === "ivory" ? colors.negra! : colors.verde!;
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
