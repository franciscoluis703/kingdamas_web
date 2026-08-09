import type { BoardState, LegalMove, Side } from "../types";
import { chooseLegendMove } from "./legendAi";
import type { LegendDifficultyKey } from "./legends";

interface LegendAiRequest {
  requestId: number;
  board: BoardState;
  player: Side;
  difficultyKey: LegendDifficultyKey;
}

self.addEventListener("message", (event: MessageEvent<LegendAiRequest>) => {
  const { requestId, board, player, difficultyKey } = event.data;
  const move: LegalMove | null = chooseLegendMove(board, player, difficultyKey);
  self.postMessage({ requestId, move });
});
