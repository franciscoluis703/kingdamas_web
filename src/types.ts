import type { EloTierLabel } from "./eloTiers";
import type { LegendDifficultyKey } from "./game/legends";
import type { AppLanguage } from "./i18n";

export type Side = "ivory" | "mahogany";
export type GameStatus = "active" | "completed" | "cancelled";

export interface WorldTitle {
  placement: "gold" | "silver" | "bronze";
  championshipYear: number | null;
  awardedAt: string | null;
}

export interface User {
  id: string;
  name: string;
  username: string;
  email?: string;
  countryCode: string;
  language?: AppLanguage;
  memberSince?: string | null;
  avatarUrl?: string | null;
  avatarVersion?: string | null;
  worldTitle?: WorldTitle | null;
  premium?: {
    active: boolean;
    source: "app_store" | "google_play" | "paypal" | null;
    expiresAt: string | null;
  };
}

export interface Piece {
  player: Side;
  king: boolean;
}

export type BoardState = Array<Array<Piece | null>>;

export interface Position {
  row: number;
  col: number;
}

export interface MoveStep {
  to: Position;
  captured: (Position & { king?: boolean }) | null;
}

export interface LegalMove {
  from: Position;
  steps: MoveStep[];
  captures: number;
  capturedKings: number;
}

export interface Rating {
  boardSize: number;
  rating: number;
  deviation: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  provisional?: boolean;
  tier: EloTierLabel;
}

export interface MachineProgress {
  unlockedCount: number;
  defeatedKeys: LegendDifficultyKey[];
}

export interface Player extends User {
  rating: Rating;
  connection?: "good" | "fair" | "poor" | null;
}

export interface GameClock {
  ivoryMs: number;
  mahoganyMs: number;
  running: Side | null;
  capturedAt: string;
  unlimited: false;
}

export interface DrawOffer {
  offeredBy: Side;
  offeredAt: string;
  status: "sent" | "received" | "pending";
}

export interface RatingChange {
  username: string;
  before: number;
  after: number;
  change: number;
  profile: Rating;
}

export interface GameRatingResult {
  system: string;
  boardSize: number;
  ivory: RatingChange;
  mahogany: RatingChange;
}

export interface Game {
  id: string;
  ratedGameId: string;
  boardSize: 10;
  board: BoardState;
  currentPlayer: Side;
  status: GameStatus;
  winner: Side | null;
  moveCount: number;
  moves: Array<{ player: Side; notation: string; captures: number }>;
  version: number;
  playerColor: Side;
  pieceColors: Record<Side, string>;
  startedAt: string;
  timeControlMinutes: number;
  clocks: GameClock;
  endReason: string | null;
  ratingResult: GameRatingResult | null;
  drawOffer: DrawOffer | null;
  players: Record<Side, Player>;
}

export type SpectatorGame = Omit<
  Game,
  "ratedGameId" | "playerColor" | "ratingResult"
>;

export interface SpectatorGameSummary {
  id: string;
  boardSize: 10;
  status: GameStatus;
  currentPlayer: Side;
  moveCount: number;
  startedAt: string;
  timeControlMinutes: number;
  clocks: GameClock;
  players: Record<Side, Player>;
  spectatorCount: number;
}

export interface LeaderboardPlayer extends Rating, User {
  position: number;
}

export interface ChatMessage {
  id: string;
  gameId: string;
  senderId: string;
  username: string;
  playerColor: Side;
  kind: "text" | "emoji";
  message: string;
  sentAt: string;
  own: boolean;
}

export interface DirectMessage {
  id: string;
  message: string;
  own: boolean;
  createdAt: string;
}

export interface DirectConversation {
  user: User;
  lastMessage: string;
  lastMessageOwn: boolean;
  lastMessageAt: string;
  unreadCount: number;
}

export interface Tournament {
  id: string;
  name: string;
  boardSize: 10;
  timeControlMinutes: number;
  status: "open" | "in_progress" | "completed" | "cancelled";
  isWorldChampionship: boolean;
  championshipYear: number | null;
  isQualifier: boolean;
  qualifierYear: number | null;
  prizePool: { amount: number; currency: string } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  participantCount: number;
  isOrganizer: boolean;
  isParticipant: boolean;
  organizer: {
    id: string;
    name: string;
    username: string;
  };
}

export interface QualifierTournamentResponse {
  tournament: Tournament | null;
  registrationStartsAt?: string;
  entryFee: { amount: string | number; currency: string };
  viewer: {
    registered: boolean;
    countryCode: string | null;
    qualified: boolean;
    eliminated: boolean;
  } | null;
}

export interface WorldChampionshipResponse {
  tournament: Tournament | null;
  nextStartsAt: string;
  titleHolders: Array<User & {
    rating: number;
    worldTitle: WorldTitle;
  }>;
  viewer: {
    directlyQualified: boolean;
    worldTitle: WorldTitle | null;
  };
}

export interface TournamentParticipant extends User {
  joinedAt: string;
  rating: number;
  tier?: EloTierLabel;
}

export interface QualifierBracketPlayer extends User {
  joinedAt: string;
  qualifiedAt: string | null;
  rating: number;
  tier: EloTierLabel;
  wins: number;
  losses: number;
  state: "registered" | "active" | "qualified" | "eliminated";
}

export interface QualifierBracketMatch {
  id: string;
  onlineGameId: string | null;
  status:
    | "scheduled"
    | "pending_opponent"
    | "active"
    | "completed"
    | "cancelled";
  winnerId: string | null;
  provisional: boolean;
  ivory: QualifierBracketPlayer;
  mahogany: QualifierBracketPlayer | null;
}

export interface QualifierBracketResponse {
  tournament: Tournament;
  countryCode: string | null;
  countries: string[];
  window: { startsAt: string; endsAt: string };
  rules: {
    qualifyingPlaces: 3;
    lossesToEliminate: 2;
    timeControlMinutes: 30;
  };
  calendar: Array<{ round: number; scheduledAt: string }>;
  rounds: Array<{
    round: number;
    scheduledAt: string;
    status: "scheduled" | "in_progress" | "completed" | "closed";
    matches: QualifierBracketMatch[];
  }>;
  participants: QualifierBracketPlayer[];
  qualifiers: QualifierBracketPlayer[];
  viewer:
    | { registered: false }
    | {
        registered: true;
        participant: QualifierBracketPlayer;
        opponent: QualifierBracketPlayer | null;
        scheduledAt: string | null;
        waitingForOpponent: boolean;
  };
}

export interface PlayerMatchHistoryEntry {
  id: string;
  boardSize: 10;
  result: "win" | "loss" | "draw";
  ratingBefore: number;
  ratingAfter: number;
  ratingChange: number;
  createdAt: string;
  opponentName: string;
  opponentUsername: string;
  opponentCountryCode: string;
  durationSeconds: number;
  timeControlMinutes: number;
  endReason: "board" | "resignation" | "timeout" | "agreement" | "withdrawal" | null;
}

export interface PlayerStatisticsResponse {
  profile: User & {
    followerCount: number;
    followingCount: number;
    isFollowing: boolean;
    isSelf: boolean;
  };
  summary: {
    totalGames: number;
    wins: number;
    losses: number;
    draws: number;
    winRate: number;
    gamesLast30Days: number;
    averageMoves: number;
    averageDuration: number;
  };
  modes: Array<Rating & {
    peakRating: number;
    worldPosition: number | null;
    countryPosition: number | null;
    winRate: number;
  }>;
}

export interface PlayerMatchHistoryResponse {
  matches: PlayerMatchHistoryEntry[];
  nextOffset: number;
  hasMore: boolean;
}

export interface MatchmakingWaiting {
  status: "waiting";
  boardSize: 10;
  timeControlMinutes: number;
  rating: number;
  waitSeconds: number;
  searchRange: number;
  queuePosition: number;
}

export interface MatchmakingMatched {
  status: "matched";
  game: Game;
}

export interface MatchmakingDirectPending {
  status: "direct_pending";
  invitation: unknown;
}

export type MatchmakingResult =
  | MatchmakingWaiting
  | MatchmakingMatched
  | MatchmakingDirectPending;

export interface LinkInvitation {
  id: string;
  token?: string;
  boardSize: 10;
  timeControlMinutes: number;
  status: "pending" | "accepted" | "cancelled" | "expired";
  expiresAt: string;
  createdAt: string;
  sender: {
    id: string;
    name: string;
    username: string;
    rating: number;
    avatarUrl?: string | null;
    worldTitle?: WorldTitle | null;
  };
}

export interface DirectInvitation {
  id: string;
  boardSize: 10;
  timeControlMinutes: number;
  status: "pending" | "accepted" | "declined" | "cancelled" | "expired";
  direction: "sent" | "received";
  expiresAt: string;
  createdAt: string;
  opponent: {
    id: string;
    name: string;
    username: string;
    rating: number;
    avatarUrl?: string | null;
    worldTitle?: WorldTitle | null;
  };
}
