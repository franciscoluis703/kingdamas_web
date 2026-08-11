import { API_URL } from "./config";
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
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
      body: json(data),
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
  donationConfig: () =>
    request<{
      enabled: boolean;
      clientId: string | null;
      currency: "USD";
      minAmount: number;
      maxAmount: number;
    }>("/donations/config"),
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
  searchUsers: (query: string) =>
    request<{ users: User[] }>(`/users/search?q=${encodeURIComponent(query)}`),
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
  following: (username: string) =>
    cachedRequest(`following:${username.toLowerCase()}`, 20_000, () =>
      request<{ users: User[] }>(
        `/users/${encodeURIComponent(username)}/following`,
      )),
  follow: async (username: string) => {
    await request<void>(`/users/${encodeURIComponent(username)}/follow`, {
      method: "POST",
    });
    invalidateCachedRequests("following:");
  },
  unfollow: async (username: string) => {
    await request<void>(`/users/${encodeURIComponent(username)}/follow`, {
      method: "DELETE",
    });
    invalidateCachedRequests("following:");
  },
  conversations: () =>
    request<{ conversations: DirectConversation[] }>("/messages"),
  directMessages: (username: string) =>
    request<{ user: User; messages: DirectMessage[] }>(
      `/messages/${encodeURIComponent(username)}`,
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
  tournamentParticipants: (tournamentId: string) =>
    request<{ participants: TournamentParticipant[] }>(
      `/tournaments/${encodeURIComponent(tournamentId)}/participants`,
    ),
  qualifierBracket: (tournamentId: string, countryCode?: string) =>
    request<QualifierBracketResponse>(
      `/tournaments/${encodeURIComponent(tournamentId)}/qualifier-bracket${countryCode ? `?countryCode=${encodeURIComponent(countryCode)}` : ""}`,
    ),
  playerStatistics: (username: string) =>
    request<PlayerStatisticsResponse>(
      `/ratings/players/${encodeURIComponent(username)}/statistics`,
    ),
  myRatings: () =>
    request<{ system: string; initialRating: number; ratings: Rating[] }>(
      "/ratings/me",
    ),
  leaderboard: (scope: "DO" | "WORLD") =>
    cachedRequest(`leaderboard:${scope}`, 15_000, () =>
      request<{
        system: string;
        totalPlayers: number;
        players: LeaderboardPlayer[];
      }>(`/ratings/leaderboard?boardSize=10&country=${scope}&limit=100`)),
  joinMatchmaking: (timeControlMinutes: number) =>
    request<MatchmakingResult>("/matchmaking/join", {
      method: "POST",
      body: json({ boardSize: 10, timeControlMinutes }),
    }),
  matchmakingStatus: (timeControlMinutes: number) =>
    request<MatchmakingResult>(
      `/matchmaking/status?boardSize=10&timeControlMinutes=${timeControlMinutes}`,
    ),
  leaveMatchmaking: () =>
    request<void>("/matchmaking/leave", { method: "DELETE" }),
  activeGame: () =>
    request<{ game: Game | null }>("/online-games/active"),
  game: (id: string) => request<{ game: Game }>(`/online-games/${id}`),
  spectatorGames: () =>
    request<{ games: SpectatorGameSummary[]; total: number }>("/spectator-games"),
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
  messages: (id: string) =>
    request<{ messages: ChatMessage[] }>(`/online-games/${id}/messages`),
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
