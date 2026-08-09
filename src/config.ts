const configuredApi = import.meta.env.VITE_API_URL?.trim();
const configuredSocket = import.meta.env.VITE_SOCKET_URL?.trim();

export const API_URL = (configuredApi || "/api").replace(/\/$/, "");
export const SOCKET_URL = configuredSocket || window.location.origin;
export const PUBLIC_APP_URL = (import.meta.env.VITE_PUBLIC_APP_URL?.trim() || window.location.origin).replace(/\/$/, "");
export const BOARD_SIZE = 10 as const;
export const TIME_CONTROLS = [10, 30, 60] as const;
export type TimeControl = (typeof TIME_CONTROLS)[number];
