import type { Side } from "../types";

export const PIECE_COLOR_OPTIONS = [
  { key: "blanca", label: "Blanca", value: "#edf2e8" },
  { key: "negra", label: "Negra", value: "#121b17" },
  { key: "verde", label: "Verde", value: "#23875c" },
  { key: "azul", label: "Azul", value: "#326bb5" },
  { key: "rojo", label: "Roja", value: "#b8493e" },
  { key: "madera", label: "Madera", value: "#9c6544" },
  { key: "rosado", label: "Rosada", value: "#d8809a" },
  { key: "dorado", label: "Dorada", value: "#d5a633" },
] as const;

export type PieceColor = (typeof PIECE_COLOR_OPTIONS)[number]["key"];
export type PieceColorRole = "own" | "opponent";
export type PieceColorPreferences = Record<PieceColorRole, PieceColor>;

export const DEFAULT_PIECE_COLOR_PREFERENCES: PieceColorPreferences = {
  own: "blanca",
  opponent: "negra",
};

const PIECE_COLOR_STORAGE_KEY = "kingdamas-piece-colors";
const PIECE_COLOR_KEYS = new Set<PieceColor>(
  PIECE_COLOR_OPTIONS.map((option) => option.key),
);

export function crownColorForPiece(color: unknown) {
  const normalized = String(color || "").trim().toLowerCase();
  if (normalized === "negra" || normalized === "#121b17") return "#ffffff";
  if (normalized === "blanca" || normalized === "#edf2e8") return "#000000";
  return "#e8b85a";
}

function isPieceColor(value: unknown): value is PieceColor {
  return typeof value === "string" && PIECE_COLOR_KEYS.has(value as PieceColor);
}

export function normalizePieceColorPreferences(value: unknown): PieceColorPreferences {
  const candidate = value && typeof value === "object"
    ? value as Partial<Record<PieceColorRole, unknown>>
    : {};
  const own = isPieceColor(candidate.own)
    ? candidate.own
    : DEFAULT_PIECE_COLOR_PREFERENCES.own;
  const preferredOpponent = isPieceColor(candidate.opponent)
    ? candidate.opponent
    : DEFAULT_PIECE_COLOR_PREFERENCES.opponent;
  const opponent = preferredOpponent === own
    ? PIECE_COLOR_OPTIONS.find((option) => option.key !== own)!.key
    : preferredOpponent;
  return { own, opponent };
}

export function pieceColorPreferences(): PieceColorPreferences {
  if (typeof localStorage === "undefined") {
    return { ...DEFAULT_PIECE_COLOR_PREFERENCES };
  }
  try {
    return normalizePieceColorPreferences(
      JSON.parse(localStorage.getItem(PIECE_COLOR_STORAGE_KEY) || "null"),
    );
  } catch {
    return { ...DEFAULT_PIECE_COLOR_PREFERENCES };
  }
}

export function setPieceColorPreference(
  role: PieceColorRole,
  color: PieceColor,
  current = pieceColorPreferences(),
): PieceColorPreferences {
  const next = normalizePieceColorPreferences(current);
  const otherRole: PieceColorRole = role === "own" ? "opponent" : "own";
  next[role] = color;
  if (next[otherRole] === color) {
    const preferredReplacement = DEFAULT_PIECE_COLOR_PREFERENCES[otherRole];
    next[otherRole] = preferredReplacement !== color
      ? preferredReplacement
      : PIECE_COLOR_OPTIONS.find((option) => option.key !== color)!.key;
  }
  try {
    localStorage.setItem(PIECE_COLOR_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // La preferencia se mantiene durante la partida aunque el navegador bloquee el almacenamiento.
  }
  return next;
}

export function pieceColorPreferencesForSide(
  playerSide: Side,
  pieceColors: Partial<Record<Side, unknown>> | null | undefined,
): PieceColorPreferences {
  return normalizePieceColorPreferences(playerSide === "ivory"
    ? { own: pieceColors?.ivory, opponent: pieceColors?.mahogany }
    : { own: pieceColors?.mahogany, opponent: pieceColors?.ivory });
}

export function pieceColorsFor(
  playerSide: Side,
  preferences = pieceColorPreferences(),
): Record<Side, PieceColor> {
  return playerSide === "ivory"
    ? { ivory: preferences.own, mahogany: preferences.opponent }
    : { ivory: preferences.opponent, mahogany: preferences.own };
}
