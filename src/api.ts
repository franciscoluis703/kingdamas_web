import { API_URL } from "./config";
import { currentLanguage, type AppLanguage } from "./i18n";
import type {
  ChatMessage,
  DirectConversation,
  DirectInvitation,
  DirectMessage,
  Game,
  LeaderboardPlayer,
  LinkInvitation,
  MatchmakingResult,
  MachineProgress,
  PlayerMatchHistoryResponse,
  PlayerStatisticsResponse,
  QualifierBracketResponse,
  Rating,
  SpectatorGame,
  SpectatorGameSummary,
  QualifierTournamentResponse,
  TournamentParticipant,
  WorldChampionshipResponse,
  User,
} from "./types";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface AppStoreConfig {
  enabled: boolean;
  appAccountToken: string | null;
  products: {
    tournamentEntry: {
      productId: string;
      qualifierYear: number;
      referenceName?: string;
      price?: number;
      currency?: string;
      type?: "consumable" | "auto_renewable_subscription";
    };
    support: Array<{
      productId: string;
      tier: "small" | "medium" | "large" | "champion";
      referenceName?: string;
      price?: number;
      currency?: string;
      type?: "consumable" | "auto_renewable_subscription";
    }>;
    adFree: Array<{
      productId: string;
      interval: "weekly" | "monthly" | "annual";
      period: "P1W" | "P1M" | "P1Y";
      referenceName?: string;
      price?: number;
      currency?: string;
      type?: "auto_renewable_subscription";
    }>;
  };
}

export interface DonationConfig {
  enabled: boolean;
  clientId: string | null;
  currency: "USD";
  minAmount: number;
  maxAmount: number;
  products: AppStoreConfig["products"];
}

export interface AppStoreConfirmation {
  status: "COMPLETED";
  purpose: "tournament_entry" | "support";
  transactionId: string;
  tournamentId: string | null;
}

export interface PremiumEntitlement {
  active: boolean;
  source: "app_store" | "google_play" | "paypal" | null;
  expiresAt: string | null;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Accept-Language", currentLanguage());
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });

  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
  } & T;
  if (!response.ok) {
    throw new ApiError(body.error || "No pudimos completar la solicitud.", response.status);
  }
  return body;
}

const json = (value: unknown) => JSON.stringify(value);
export const LIST_PAGE_SIZE = 5;

const responseCache = new Map<string, {
  expiresAt: number;
  promise: Promise<unknown>;
}>();

function cachedRequest<T>(key: string, ttlMs: number, load: () => Promise<T>) {
  const cached = responseCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise as Promise<T>;
  }

  const promise = load().catch((error) => {
    if (responseCache.get(key)?.promise === promise) responseCache.delete(key);
    throw error;
  });
  responseCache.set(key, { expiresAt: Date.now() + ttlMs, promise });
  return promise;
}

function invalidateCachedRequests(prefix: string) {
  for (const key of responseCache.keys()) {
    if (key.startsWith(prefix)) responseCache.delete(key);
  }
}

export const api = {
  me: () => request<{ user: User }>("/auth/me"),
  login: (identifier: string, password: string) =>
    request<{ user: User }>("/auth/login", {
      method: "POST",
      body: json({ identifier, password }),
    }),
  register: (data: {
    name: string;
    username: string;
    email: string;
    countryCode: string;
    password: string;
  }) =>
    request<{ user: User }>("/auth/register", {
      method: "POST",
      body: json({ ...data, language: currentLanguage() }),
    }),
  forgotPassword: (email: string) =>
    request<{ message: string }>("/auth/forgot-password", {
      method: "POST",
      body: json({ email }),
    }),
  resetPassword: (token: string, password: string) =>
    request<{ message: string }>("/auth/reset-password", {
      method: "POST",
      body: json({ token, password }),
    }),
  deleteAccount: (password: string) =>
    request<void>("/auth/account", {
      method: "DELETE",
      body: json({ password }),
    }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  updateAvatar: (file: File) =>
    request<{
      avatar: { avatarUrl: string | null; avatarVersion: string | null };
    }>("/users/me/avatar", {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file,
    }),
  removeAvatar: () =>
    request<void>("/users/me/avatar", { method: "DELETE" }),
  updateLanguage: (language: AppLanguage) =>
    request<{ language: AppLanguage }>("/users/me/preferences", {
      method: "PATCH",
      body: json({ language }),
    }),
  donationConfig: () =>
    cachedRequest("donations:config", 5 * 60_000, () =>
      request<DonationConfig>("/donations/config")),
  appStoreConfig: () => request<AppStoreConfig>("/app-store/config"),
  confirmAppStoreTransaction: (signedTransactionInfo: string) =>
    request<AppStoreConfirmation>("/app-store/transactions/confirm", {
      method: "POST",
      body: json({ signedTransactionInfo }),
    }),
  premiumStatus: () =>
    request<{ premium: PremiumEntitlement }>("/premium/status"),
  syncAppStoreSubscription: (
    signedTransactionInfo: string,
    signedRenewalInfo?: string | null,
  ) => request<{ premium: PremiumEntitlement }>("/app-store/subscriptions/sync", {
    method: "POST",
    body: json({ signedTransactionInfo, signedRenewalInfo }),
  }),
  playStoreConfig: () => request<AppStoreConfig>("/play-store/config"),
  confirmPlayStoreTransaction: (productId: string, purchaseToken: string) =>
    request<AppStoreConfirmation>("/play-store/transactions/confirm", {
      method: "POST",
      body: json({ productId, purchaseToken }),
    }),
  syncPlayStoreSubscription: (productId: string, purchaseToken: string) =>
    request<{ premium: PremiumEntitlement }>("/play-store/subscriptions/sync", {
      method: "POST",
      body: json({ productId, purchaseToken }),
    }),
  createDonationOrder: (amount: number) =>
    request<{ id: string }>("/donations/create-order", {
      method: "POST",
      body: json({ amount }),
    }),
  captureDonationOrder: (orderId: string) =>
    request<{ status: string }>(
      `/donations/${encodeURIComponent(orderId)}/capture`,
      { method: "POST" },
    ),
  createWebProductOrder: (productId: string) =>
    request<{ id: string }>(
      `/donations/products/${encodeURIComponent(productId)}/create-order`,
      { method: "POST" },
    ),
  captureWebProductOrder: (productId: string, orderId: string) =>
    request<{
      status: string;
      purpose: "support" | "premium";
      productId: string;
      premium?: PremiumEntitlement;
    }>(
      `/donations/products/${encodeURIComponent(productId)}/${encodeURIComponent(orderId)}/capture`,
      { method: "POST" },
    ),
  searchUsers: (query: string, offset = 0) =>
    request<{ users: User[]; nextOffset: number; hasMore: boolean }>(
      `/users/search?q=${encodeURIComponent(query)}&offset=${offset}`,
    ),
  communityStats: () =>
    cachedRequest("community-stats", 60_000, () =>
      request<{ registeredUsers: number }>("/community/stats")),
  machineProgress: () =>
    request<{ progress: Record<string, MachineProgress> }>("/machine-progress"),
  recordMachineWin: (difficultyKey: string) =>
    request<MachineProgress & { justUnlocked: boolean }>("/machine-progress", {
      method: "POST",
      body: json({ boardSize: 10, difficultyKey }),
    }),
  following: (username: string, offset = 0) =>
    cachedRequest(`following:${username.toLowerCase()}:${offset}`, 20_000, () =>
      request<{
        users: User[];
        total: number;
        nextOffset: number;
        hasMore: boolean;
      }>(
        `/users/${encodeURIComponent(username)}/following?offset=${offset}`,
      )),
  followers: (username: string, offset = 0) =>
    cachedRequest(`followers:${username.toLowerCase()}:${offset}`, 20_000, () =>
      request<{ users: User[]; nextOffset: number; hasMore: boolean }>(
        `/users/${encodeURIComponent(username)}/followers?offset=${offset}`,
      )),
  follow: async (username: string) => {
    await request<void>(`/users/${encodeURIComponent(username)}/follow`, {
      method: "POST",
    });
    invalidateCachedRequests("following:");
    invalidateCachedRequests("followers:");
  },
  unfollow: async (username: string) => {
    await request<void>(`/users/${encodeURIComponent(username)}/follow`, {
      method: "DELETE",
    });
    invalidateCachedRequests("following:");
    invalidateCachedRequests("followers:");
  },
  conversations: (offset = 0) =>
    request<{
      conversations: DirectConversation[];
      total: number;
      unreadCount: number;
      nextOffset: number;
      hasMore: boolean;
    }>(`/messages?offset=${offset}`),
  directMessages: (username: string, offset = 0) =>
    request<{
      user: User;
      messages: DirectMessage[];
      nextOffset: number;
      hasMore: boolean;
    }>(
      `/messages/${encodeURIComponent(username)}?offset=${offset}`,
    ),
  sendDirectMessage: (username: string, message: string) =>
    request<{ message: DirectMessage }>(
      `/messages/${encodeURIComponent(username)}`,
      { method: "POST", body: json({ message }) },
    ),
  qualifierTournament: () =>
    request<QualifierTournamentResponse>("/tournaments/qualifier"),
  worldChampionship: () =>
    request<WorldChampionshipResponse>("/tournaments/world-championship"),
  createTournamentEntryOrder: (tournamentId: string) =>
    request<{ id: string }>(
      `/tournaments/${encodeURIComponent(tournamentId)}/entry/create-order`,
      { method: "POST" },
    ),
  captureTournamentEntryOrder: (tournamentId: string, orderId: string) =>
    request<{ status: string }>(
      `/tournaments/${encodeURIComponent(tournamentId)}/entry/${encodeURIComponent(orderId)}/capture`,
      { method: "POST" },
    ),
  tournamentParticipants: (tournamentId: string, offset = 0, query = "") =>
    request<{
      participants: TournamentParticipant[];
      total: number;
      nextOffset: number;
      hasMore: boolean;
    }>(
      `/tournaments/${encodeURIComponent(tournamentId)}/participants?offset=${offset}${query ? `&q=${encodeURIComponent(query)}` : ""}`,
    ),
  qualifierBracket: (tournamentId: string, countryCode?: string) =>
    request<QualifierBracketResponse>(
      `/tournaments/${encodeURIComponent(tournamentId)}/qualifier-bracket${countryCode ? `?countryCode=${encodeURIComponent(countryCode)}` : ""}`,
    ),
  playerStatistics: (username: string) =>
    request<PlayerStatisticsResponse>(
      `/ratings/players/${encodeURIComponent(username)}/statistics`,
    ),
  playerHistory: (username: string, offset = 0) =>
    request<PlayerMatchHistoryResponse>(
      `/ratings/players/${encodeURIComponent(username)}/history?offset=${offset}`,
    ),
  myRatings: () =>
    cachedRequest("ratings:me", 2_500, () =>
      request<{ system: string; initialRating: number; ratings: Rating[] }>(
        "/ratings/me",
      )),
  leaderboard: (scope: "DO" | "WORLD", offset = 0) =>
    cachedRequest(`leaderboard:${scope}:${offset}`, 15_000, () =>
      request<{
        system: string;
        totalPlayers: number;
        players: LeaderboardPlayer[];
        nextOffset: number;
        hasMore: boolean;
      }>(`/ratings/leaderboard?boardSize=10&country=${scope}&limit=${LIST_PAGE_SIZE}&offset=${offset}`)),
  joinMatchmaking: (timeControlMinutes: number, pieceColor: string) =>
    request<MatchmakingResult>("/matchmaking/join", {
      method: "POST",
      body: json({ boardSize: 10, timeControlMinutes, pieceColor }),
    }),
  matchmakingStatus: (timeControlMinutes: number, pieceColor: string) =>
    request<MatchmakingResult>(
      `/matchmaking/status?boardSize=10&timeControlMinutes=${timeControlMinutes}&pieceColor=${encodeURIComponent(pieceColor)}`,
    ),
  leaveMatchmaking: () =>
    request<void>("/matchmaking/leave", { method: "DELETE" }),
  activeGame: () =>
    request<{ game: Game | null }>("/online-games/active"),
  game: (id: string) => request<{ game: Game }>(`/online-games/${id}`),
  updateGamePieceColors: (id: string, ownColor: string, opponentColor: string) =>
    request<{ game: Game }>(`/online-games/${id}/piece-colors`, {
      method: "PATCH",
      body: json({ ownColor, opponentColor }),
    }),
  spectatorGames: (offset = 0) =>
    request<{
      games: SpectatorGameSummary[];
      total: number;
      nextOffset: number;
      hasMore: boolean;
    }>(`/spectator-games?offset=${offset}`),
  spectatorGame: (id: string) =>
    request<{ game: SpectatorGame; spectatorCount: number }>(
      `/spectator-games/${encodeURIComponent(id)}`,
    ),
  move: (id: string, move: unknown, version: number) =>
    request<{ game: Game }>(`/online-games/${id}/moves`, {
      method: "POST",
      body: json({ move, version }),
    }),
  resign: (id: string) =>
    request<{ game: Game }>(`/online-games/${id}/resign`, { method: "POST" }),
  withdraw: (id: string) =>
    request<{ game: Game; withdrawal: { escalated: boolean } }>(
      `/online-games/${id}/withdraw`,
      { method: "POST" },
    ),
  offerDraw: (id: string) =>
    request<{ game: Game }>(`/online-games/${id}/draw-offer`, { method: "POST" }),
  respondDraw: (id: string, accept: boolean) =>
    request<{ game: Game }>(`/online-games/${id}/draw-offer/respond`, {
      method: "POST",
      body: json({ accept }),
    }),
  messages: (id: string, beforeId?: string) =>
    request<{
      messages: ChatMessage[];
      nextBeforeId: string | null;
      hasMore: boolean;
    }>(`/online-games/${id}/messages${beforeId ? `?before=${encodeURIComponent(beforeId)}` : ""}`),
  sendMessage: (id: string, message: string, kind: "text" | "emoji" = "text") =>
    request<{ message: ChatMessage }>(`/online-games/${id}/messages`, {
      method: "POST",
      body: json({ kind, message }),
    }),
  createLinkInvitation: (timeControlMinutes: number) =>
    request<{ invitation: LinkInvitation }>("/link-invitations", {
      method: "POST",
      body: json({ boardSize: 10, timeControlMinutes }),
    }),
  linkInvitation: (token: string) =>
    request<{ invitation: LinkInvitation }>(
      `/link-invitations/${encodeURIComponent(token)}`,
    ),
  linkInvitationStatus: (token: string) =>
    request<{ invitation: LinkInvitation; game: Game | null }>(
      `/link-invitations/${encodeURIComponent(token)}/status`,
    ),
  acceptLinkInvitation: (token: string) =>
    request<{ invitation: LinkInvitation; game: Game }>(
      `/link-invitations/${encodeURIComponent(token)}/accept`,
      { method: "POST" },
    ),
  cancelLinkInvitation: (token: string) =>
    request<void>(`/link-invitations/${encodeURIComponent(token)}/cancel`, {
      method: "POST",
    }),
  invitations: () =>
    request<{ invitations: DirectInvitation[] }>("/invitations"),
  createInvitation: (identifier: string, timeControlMinutes: number) =>
    request<{ invitation: DirectInvitation }>("/invitations", {
      method: "POST",
      body: json({ identifier, boardSize: 10, timeControlMinutes }),
    }),
  invitationStatus: (id: string) =>
    request<{ invitation: DirectInvitation; game: Game | null }>(
      `/invitations/${encodeURIComponent(id)}`,
    ),
  acceptInvitation: (id: string) =>
    request<{ invitation: DirectInvitation; game: Game }>(
      `/invitations/${encodeURIComponent(id)}/accept`,
      { method: "POST" },
    ),
  declineInvitation: (id: string) =>
    request<void>(`/invitations/${encodeURIComponent(id)}/decline`, {
      method: "POST",
    }),
  cancelInvitation: (id: string) =>
    request<void>(`/invitations/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    }),
};
