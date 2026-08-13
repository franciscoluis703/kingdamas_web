import type { Socket } from "socket.io-client";
import "./styles.css";
import { api, ApiError, LIST_PAGE_SIZE, type AppStoreConfig } from "./api";
import { PUBLIC_APP_URL, SOCKET_URL, TIME_CONTROLS, type TimeControl } from "./config";
import { ELO_TIERS, eloTier, eloTierRange } from "./eloTiers";
import { CmCheckersboard } from "./game/CmCheckersboard";
import { decorativeBoardMarkup } from "./game/decorativeBoard";
import { CHALLENGE_EMOJIS, MAX_GAME_CHAT_LENGTH } from "./game/chat";
import { applyMove, countPieces, createInitialBoard, getWinner, moveNotation, opponentOf } from "./game/engine";
import { spectatorClockValue } from "./game/spectators";
import { friendChallengeMessage, friendChallengeText } from "./sharing";
import {
  LEGENDS,
  legendByKey,
  legendIndex,
  type Legend,
  type LegendDifficultyKey,
} from "./game/legends";
import {
  AUDIO_CREDITS,
  playMoveSound,
  setBackgroundSound,
  setBackgroundVolume,
  setMoveSound,
  soundPreferences,
  startBackgroundSound,
  stopBackgroundSound,
} from "./game/sound";
import {
  PIECE_COLOR_OPTIONS,
  pieceColorPreferences,
  pieceColorPreferencesForSide,
  pieceColorsFor,
  setPieceColorPreference,
  type PieceColor,
  type PieceColorPreferences,
  type PieceColorRole,
} from "./game/pieceColorPreferences";
import type {
  BoardState,
  ChatMessage,
  DirectConversation,
  DirectInvitation,
  DirectMessage,
  Game,
  LeaderboardPlayer,
  LegalMove,
  LinkInvitation,
  MatchmakingResult,
  PlayerMatchHistoryEntry,
  QualifierBracketMatch,
  QualifierBracketPlayer,
  QualifierBracketResponse,
  QualifierTournamentResponse,
  Rating,
  Side,
  SpectatorGame,
  SpectatorGameSummary,
  Tournament,
  TournamentParticipant,
  User,
  WorldChampionshipResponse,
} from "./types";
import { avatarMarkup, escapeHtml, flag, formatClock, icon } from "./ui";
import { isPublicContentPath, normalizePublicPath } from "./publicRoutes";
import {
  finishNativeStoreTransaction,
  hideNativeAdBanner,
  isIOSNativeApp,
  listenForNativeStoreTransactions,
  manageNativeSubscriptions,
  nativeAdsStatus,
  nativeSubscriptionStatus,
  nativeStoreProducts,
  purchaseNativeSubscription,
  purchaseNativeStoreProduct,
  restoreNativeSubscriptions,
  setNativeAdsPremiumStatus,
  showNativeAdBanner,
  showNativeAdPrivacyOptions,
  showNativeGameInterstitial,
  unfinishedNativeStoreTransactions,
  type NativeStoreProduct,
  type NativeStoreTransaction,
} from "./nativeStore";
import {
  LANGUAGE_CHANGE_EVENT,
  currentLanguage,
  languageSelectorMarkup,
  localeCode,
  translateText,
  useUserLanguage,
  type AppLanguage,
} from "./i18n";

interface PayPalButtonsInstance {
  render: (container: HTMLElement) => Promise<void>;
  close?: () => void;
}

interface PayPalNamespace {
  Buttons: (options: {
    style?: Record<string, string | boolean | number>;
    createOrder: () => Promise<string>;
    onApprove: (data: { orderID: string }) => Promise<void>;
    onCancel?: () => void;
    onError?: (error: unknown) => void;
  }) => PayPalButtonsInstance;
}

declare global {
  interface Window {
    paypal?: PayPalNamespace;
  }
}

const root = document.querySelector<HTMLDivElement>("#app")!;
if (!root) throw new Error("No se encontró el contenedor principal.");

let currentUser: User | null = null;
let socket: Socket | null = null;
let pageCleanup: (() => void) | null = null;
let pageLeaveGuard: (() => Promise<boolean>) | null = null;
let pendingLeaveDecision: Promise<boolean> | null = null;
let toastTimer: number | null = null;
let matchmakingTimer: number | null = null;
let matchmakingStartedAt = 0;
let selectedTime: TimeControl = 10;
let linkInvitationTimer: number | null = null;
let currentRating: Rating | null = null;
let paypalSdkPromise: Promise<PayPalNamespace> | null = null;
let socketIoPromise: Promise<typeof import("socket.io-client")> | null = null;
let outgoingChallengeDialog: HTMLDialogElement | null = null;
let outgoingChallengeTimer: number | null = null;
let incomingChallengeDialog: HTMLDialogElement | null = null;
let incomingChallengeId: string | null = null;
let incomingChallengeCheckRunning = false;
let languageListenerBound = false;
let languageSaveQueue: Promise<void> = Promise.resolve();
let nativeStoreRecoveryUserId: string | null = null;
let nativeStoreListenerBound = false;
const nativeStoreConfirmations = new Map<string, Promise<void>>();
let premiumActive = false;
let nativeAdPrivacyOptionsRequired = false;

const LEGAL_CONSENT_VERSION = "2026-08-11";
const SESSION_HINT_KEY = "kingdamas_session_hint";
const LEGAL_ROUTES = [
  { path: "/acerca-de", label: "Acerca de", shortLabel: "Acerca de" },
  { path: "/contacto", label: "Contacto", shortLabel: "Contacto" },
  { path: "/politica-de-cookies", label: "Política de cookies", shortLabel: "Cookies" },
  { path: "/terminos-y-condiciones", label: "Términos y condiciones", shortLabel: "Términos" },
  { path: "/politica-de-privacidad", label: "Política de privacidad", shortLabel: "Privacidad" },
] as const;

function applyPremiumStatus(active: boolean, expiresAt: string | null = null) {
  premiumActive = active;
  document.documentElement.dataset.premium = String(active);
  if (currentUser) {
    currentUser = {
      ...currentUser,
      premium: {
        active,
        source: active ? "app_store" : null,
        expiresAt,
      },
    };
  }
}

async function syncAccountPremium(
  subscription?: Awaited<ReturnType<typeof nativeSubscriptionStatus>>,
  appAccountToken?: string | null,
  strict = false,
) {
  if (
    subscription?.active &&
    subscription.appAccountToken &&
    subscription.appAccountToken.toLowerCase() === appAccountToken?.toLowerCase()
  ) {
    await setNativeAdsPremiumStatus(true);
  }
  let response;
  if (subscription?.signedTransactionInfo) {
    try {
      response = await api.syncAppStoreSubscription(
        subscription.signedTransactionInfo,
        subscription.signedRenewalInfo,
      );
    } catch (error) {
      if (strict) throw error;
      console.warn("La suscripción local no pertenece a esta cuenta; se usará el estado del servidor.", error);
      response = await api.premiumStatus();
    }
  } else {
    response = await api.premiumStatus();
  }
  applyPremiumStatus(response.premium.active, response.premium.expiresAt);
  await setNativeAdsPremiumStatus(response.premium.active);
  return response.premium;
}
type LegalPath = (typeof LEGAL_ROUTES)[number]["path"];

const route = () => {
  const hashPath = location.hash.replace(/^#/, "");
  if (hashPath) return hashPath;
  const publicPath = normalizePublicPath(location.pathname);
  return isPublicContentPath(publicPath) ? publicPath : "/inicio";
};
let renderedPath = route();
let bypassNextHashGuard = false;

async function requestPageLeave() {
  const guard = pageLeaveGuard;
  if (!guard) return true;
  if (pendingLeaveDecision) return pendingLeaveDecision;
  const decision = guard()
    .then((allowed) => {
      if (allowed && pageLeaveGuard === guard) pageLeaveGuard = null;
      return allowed;
    })
    .finally(() => {
      pendingLeaveDecision = null;
    });
  pendingLeaveDecision = decision;
  return decision;
}

async function navigateSafely(path: string) {
  if (route() === path) {
    if (!pageLeaveGuard) await renderRoute();
    return;
  }
  if (!(await requestPageLeave())) return;
  bypassNextHashGuard = true;
  location.hash = path;
}

function navigate(path: string) {
  void navigateSafely(path);
}

function toast(message: string, kind: "success" | "error" = "success") {
  document.querySelector(".toast")?.remove();
  if (toastTimer) window.clearTimeout(toastTimer);
  const element = document.createElement("div");
  element.className = `toast toast--${kind}`;
  element.setAttribute("role", "status");
  element.textContent = message;
  document.body.append(element);
  requestAnimationFrame(() => element.classList.add("is-visible"));
  toastTimer = window.setTimeout(() => element.remove(), 3800);
}

function errorMessage(error: unknown) {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "Algo salió mal. Inténtalo de nuevo.";
}

interface ConfirmationDialogOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  note?: string;
}

function confirmAction({
  title,
  message,
  confirmLabel,
  cancelLabel = "Seguir jugando",
  note = "El reloj continúa avanzando mientras la partida esté activa.",
}: ConfirmationDialogOptions) {
  return new Promise<boolean>((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "kingdamas-confirm-dialog";
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "kingdamas-confirm-title");
    dialog.setAttribute("aria-describedby", "kingdamas-confirm-message");
    dialog.innerHTML = `
      <header class="kingdamas-confirm-header">
        <span class="kingdamas-confirm-brand"><img src="/favicon-64.png?v=piece-1" width="36" height="36" alt="" /><span><small>KINGDAMAS.COM</small><b>Decisión de partida</b></span></span>
        <button type="button" data-confirm-close aria-label="Cerrar diálogo">×</button>
      </header>
      <div class="kingdamas-confirm-content">
        <span class="kingdamas-confirm-symbol" aria-hidden="true">!</span>
        <div><h2 id="kingdamas-confirm-title"></h2><p id="kingdamas-confirm-message"></p></div>
      </div>
      <p class="kingdamas-confirm-note"><span aria-hidden="true">◷</span></p>
      <footer class="kingdamas-confirm-actions">
        <button class="button button--quiet" type="button" data-confirm-cancel autofocus></button>
        <button class="button button--danger kingdamas-confirm-danger" type="button" data-confirm-accept></button>
      </footer>`;

    const titleElement = dialog.querySelector<HTMLElement>("#kingdamas-confirm-title");
    const messageElement = dialog.querySelector<HTMLElement>("#kingdamas-confirm-message");
    const noteElement = dialog.querySelector<HTMLElement>(".kingdamas-confirm-note");
    const cancelButton = dialog.querySelector<HTMLButtonElement>("[data-confirm-cancel]");
    const acceptButton = dialog.querySelector<HTMLButtonElement>("[data-confirm-accept]");
    if (titleElement) titleElement.textContent = title;
    if (messageElement) messageElement.textContent = message;
    if (noteElement) noteElement.append(document.createTextNode(note));
    if (cancelButton) cancelButton.textContent = cancelLabel;
    if (acceptButton) acceptButton.textContent = confirmLabel;

    let settled = false;
    const settle = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(accepted);
    };
    dialog.querySelector("[data-confirm-close]")?.addEventListener("click", () => settle(false));
    cancelButton?.addEventListener("click", () => settle(false));
    acceptButton?.addEventListener("click", () => settle(true));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      settle(false);
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) settle(false);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

function bindNavigation() {
  root.querySelectorAll<HTMLElement>("[data-route]").forEach((element) => {
    element.addEventListener("click", () => navigate(element.dataset.route || "/inicio"));
  });
  root.querySelector<HTMLButtonElement>("[data-logout]")?.addEventListener("click", async () => {
    if (!(await requestPageLeave())) return;
    try {
      await api.logout();
    } finally {
      currentUser = null;
      applyPremiumStatus(false);
      currentRating = null;
      setSessionHint(false);
      socket?.disconnect();
      socket = null;
      navigate("/inicio");
      toast("Sesión cerrada.");
    }
  });
  root.querySelector<HTMLButtonElement>("[data-menu]")?.addEventListener("click", () => {
    root.querySelector(".sidebar")?.classList.toggle("is-open");
  });
  bindProfilePhotoDialog();
  bindAccountDeletionDialog();
  bindLegalConsent();
}

function legalConsentKey() {
  return currentUser ? `kingdamas_legal_consent:${currentUser.id}` : "";
}

function legalConsentAcceptedAt() {
  const key = legalConsentKey();
  if (!key) return null;
  try {
    const stored = JSON.parse(localStorage.getItem(key) || "null") as { version?: string; acceptedAt?: string } | null;
    return stored?.version === LEGAL_CONSENT_VERSION && stored.acceptedAt ? stored.acceptedAt : null;
  } catch {
    return null;
  }
}

function legalConsentBannerMarkup() {
  if (!currentUser || legalConsentAcceptedAt()) return "";
  return `<section class="legal-consent-banner" role="region" aria-label="Consentimiento de términos">
    <span class="legal-consent-icon">✓</span>
    <div><b>Tu juego, tus datos y reglas claras</b><p>Para continuar, confirma que aceptas los <button type="button" data-route="/terminos-y-condiciones">Términos y condiciones</button> y que leíste la <button type="button" data-route="/politica-de-privacidad">Política de privacidad</button>.</p></div>
    <button class="button button--primary" type="button" data-accept-terms>Aceptar y continuar</button>
  </section>`;
}

function bindLegalConsent() {
  root.querySelectorAll<HTMLButtonElement>("[data-accept-terms]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = legalConsentKey();
      const acceptedAt = new Date().toISOString();
      if (key) {
        try {
          localStorage.setItem(key, JSON.stringify({ version: LEGAL_CONSENT_VERSION, acceptedAt }));
        } catch {
          // La confirmación visual se mantiene aunque el navegador bloquee el almacenamiento local.
        }
      }
      root.querySelector(".legal-consent-banner")?.remove();
      const status = root.querySelector<HTMLElement>("[data-legal-consent-status]");
      if (status) status.innerHTML = `<i>✓</i><span><b>Términos aceptados</b><small>Confirmados ahora para esta cuenta.</small></span>`;
      root.querySelectorAll<HTMLButtonElement>("[data-accept-terms]").forEach((acceptButton) => {
        acceptButton.disabled = true;
        acceptButton.textContent = "Términos aceptados";
      });
      toast("Términos y condiciones aceptados. Gracias por formar parte de King Damas.");
    });
  });
}

function brandMarkMarkup() {
  return `<span class="brand-mark"><img src="/favicon-64.png?v=piece-1" width="64" height="64" alt="" /></span>`;
}

function logoMarkup() {
  return `${brandMarkMarkup()}<span class="brand-name">King <b>Damas</b></span>`;
}

const WORLD_TROPHY_DETAILS = {
  gold: { image: "/assets/trophies/world-gold.png", label: "Campeón Mundial · primer lugar", podiumLabel: "Primer lugar" },
  silver: { image: "/assets/trophies/world-silver.png", label: "Campeón Mundial · segundo lugar", podiumLabel: "Segundo lugar" },
  bronze: { image: "/assets/trophies/world-bronze.png", label: "Campeón Mundial · tercer lugar", podiumLabel: "Tercer lugar" },
} as const;

const WORLD_TROPHY_CREDIT = {
  title: "Award Trophies",
  creator: "OpenClipart.org",
  creatorUrl: "https://openclipart.org/",
  sources: [
    { placement: "gold", label: "Oro", url: "https://openclipart.org/detail/302918" },
    { placement: "silver", label: "Plata", url: "https://openclipart.org/detail/302917" },
    { placement: "bronze", label: "Bronce", url: "https://openclipart.org/detail/302916" },
  ],
} as const;

function worldTrophyMarkup(
  player: Pick<User, "worldTitle">,
  extraClass = "",
) {
  const title = player.worldTitle;
  if (!title) return "";
  const trophy = WORLD_TROPHY_DETAILS[title.placement];
  const recognition = `Podio Mundial vigente · ${trophy.label}`;
  return `<span class="world-trophy ${extraClass}" title="${escapeHtml(recognition)}" aria-label="${escapeHtml(recognition)}"><img src="${trophy.image}" width="32" height="32" alt="" /></span>`;
}

function worldTitleRecognitionMarkup(
  player: Pick<User, "worldTitle">,
  extraClass = "",
) {
  const title = player.worldTitle;
  if (!title) return "";
  const trophy = WORLD_TROPHY_DETAILS[title.placement];
  return `<span class="world-title-recognition is-${title.placement} ${extraClass}"><strong>PODIO MUNDIAL VIGENTE</strong><small>${escapeHtml(trophy.podiumLabel)}</small></span>`;
}

function playerProfileButton(
  player: Pick<User, "username" | "name">,
  content: string,
  className = "",
) {
  return `<button class="player-profile-link ${className}" type="button" data-player-profile-link="${escapeHtml(player.username)}" aria-label="Ver perfil de ${escapeHtml(player.name)}">${content}</button>`;
}

function publicHeader() {
  return `
    <header class="public-header container">
      <a class="brand" href="/" aria-label="Ir al inicio">${logoMarkup()}</a>
      <nav class="public-nav" aria-label="Navegación principal">
        <a href="/como-jugar">Cómo jugar</a>
        <a href="/acerca-de">Acerca de</a>
        ${languageSelectorMarkup("language-selector--public")}
        <button class="button button--quiet" type="button" data-open-auth="login">Entrar</button>
        <button class="button button--primary button--small" type="button" data-open-auth="register">Crear cuenta</button>
      </nav>
    </header>`;
}

function publicFooterMarkup() {
  return `<footer class="public-footer container"><span>© ${new Date().getFullYear()} King Damas</span><nav aria-label="Información legal"><a href="/acerca-de">Acerca de</a><a href="/contacto">Contacto</a><a href="/politica-de-cookies">Cookies</a><a href="/terminos-y-condiciones">Términos</a><a href="/politica-de-privacidad">Privacidad</a></nav></footer>`;
}

function publicPageLayout(content: string) {
  return `<div class="landing public-information-shell">${publicHeader()}<main class="public-information-page container">${content}</main>${publicFooterMarkup()}${authDialogMarkup()}</div>`;
}

function appLayout(content: string, active: "home" | "ranking" | "game" | "watch" | "community" | "tournaments" | "donate" | "credits" | "legal" = "home") {
  if (!currentUser) return content;
  const avatar = avatarMarkup(currentUser, "avatar avatar--small");
  return `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar-brand brand">${logoMarkup()}</div>
        <nav class="sidebar-nav" aria-label="Navegación de la cuenta">
          <button class="nav-item ${active === "home" ? "is-active" : ""}" data-route="/inicio">${icon("home")}<span>Inicio</span></button>
          <button class="nav-item ${active === "game" ? "is-active" : ""}" data-route="/jugar">${icon("play")}<span>Jugar</span></button>
          <button class="nav-item ${active === "watch" ? "is-active" : ""}" data-route="/en-vivo">${icon("eye")}<span>En vivo</span></button>
          <button class="nav-item ${active === "ranking" ? "is-active" : ""}" data-route="/clasificacion">${icon("ranking")}<span>Clasificación</span></button>
          <button class="nav-item ${active === "community" ? "is-active" : ""}" data-route="/comunidad">${icon("users")}<span>Comunidad</span></button>
          <button class="nav-item ${active === "tournaments" ? "is-active" : ""}" data-route="/torneos">${icon("tournament")}<span>Torneos</span></button>
        </nav>
        <button class="nav-item sidebar-information-link ${active === "legal" ? "is-active" : ""}" type="button" data-route="/informacion"><i>i</i><span>Información</span></button>
        <button class="sidebar-donate ${active === "donate" ? "is-active" : ""}" type="button" data-route="/donar">
          <span class="sidebar-donate-icon">${icon("heart")}</span>
          <span><small>APOYA EL PROYECTO</small><b>${isIOSNativeApp() ? "Apoyar" : "Donar"}</b></span>
          <i aria-hidden="true">→</i>
        </button>
        ${isIOSNativeApp() ? `<button class="nav-item sidebar-ad-free" type="button" data-route="/donar"><span>♢</span><span>${premiumActive ? "Cuenta Premium" : "Quitar anuncios"}</span></button>` : ""}
        <button class="sidebar-credits ${active === "credits" ? "is-active" : ""}" type="button" data-route="/creditos"><span class="sidebar-credits-icon">©</span><span><b>Créditos</b><small>Autores y licencias</small></span><i aria-hidden="true">→</i></button>
        <button class="nav-item nav-item--logout" data-logout>${icon("logout")}<span>Cerrar sesión</span></button>
      </aside>
      <div class="app-stage">
        <header class="app-header">
          <button class="icon-button mobile-menu" type="button" data-menu aria-label="Abrir menú">${icon("menu")}</button>
          <button class="mobile-brand brand brand--button" type="button" data-route="/inicio">${logoMarkup()}</button>
          ${languageSelectorMarkup("language-selector--app")}
          <button class="account-chip" type="button" data-player-profile-link="${escapeHtml(currentUser.username)}" aria-label="Ver tu perfil">
            <span class="avatar-slot" data-current-user-avatar data-avatar-class="avatar avatar--small">${avatar}</span>
            <span class="account-copy"><span class="account-name-line"><b>${escapeHtml(currentUser.name)}</b>${worldTrophyMarkup(currentUser, "world-trophy--account")}</span><small>@${escapeHtml(currentUser.username)}${premiumActive ? " · Premium" : ""}</small></span>
            <span class="account-camera" aria-hidden="true">${icon("eye")}</span>
          </button>
        </header>
        <main class="app-content">${content}</main>
      </div>
      <nav class="bottom-nav" aria-label="Navegación móvil">
        <button class="${active === "home" ? "is-active" : ""}" data-route="/inicio">${icon("home")}<span>Inicio</span></button>
        <button class="bottom-nav-play ${active === "game" ? "is-active" : ""}" data-route="/jugar">${icon("play")}<span>Jugar</span></button>
        <button class="${active === "ranking" ? "is-active" : ""}" data-route="/clasificacion">${icon("ranking")}<span>Ranking</span></button>
      </nav>
      ${profilePhotoDialogMarkup()}
      ${legalConsentBannerMarkup()}
    </div>`;
}

function profilePhotoDialogMarkup() {
  if (!currentUser) return "";
  return `
    <dialog class="profile-photo-dialog" aria-labelledby="profile-photo-title">
      <button class="dialog-close" type="button" data-close-profile-photo aria-label="Cerrar">×</button>
      <span class="section-kicker">TU CUENTA</span>
      <h2 id="profile-photo-title">Foto de perfil</h2>
      <p>Elige una imagen clara para que tus rivales puedan reconocerte.</p>
      <button class="profile-photo-preview" type="button" data-choose-profile-photo aria-label="Elegir una foto">
        <span data-photo-preview>${avatarMarkup(currentUser, "avatar avatar--profile")}</span>
        <span class="profile-photo-camera">${icon("camera")}</span>
      </button>
      <input class="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" data-profile-photo-input />
      <small class="profile-photo-help">JPG, PNG o WebP · máximo 8 MB</small>
      <p class="profile-photo-error" data-profile-photo-error aria-live="polite"></p>
      <div class="profile-photo-actions">
        <button class="button button--quiet" type="button" data-choose-profile-photo>${icon("camera")} Elegir foto</button>
        <button class="button button--primary" type="button" data-save-profile-photo disabled>Guardar foto</button>
      </div>
      <button class="text-button text-button--danger profile-photo-remove" type="button" data-remove-profile-photo ${currentUser.avatarUrl ? "" : "hidden"}>Eliminar foto actual</button>
      <details class="account-management">
        <summary>Administrar cuenta</summary>
        <div><small>ZONA SENSIBLE</small><p>Opciones permanentes relacionadas con tu cuenta.</p><button type="button" data-open-delete-account>Eliminar cuenta</button></div>
      </details>
    </dialog>
    <dialog class="delete-account-dialog" aria-labelledby="delete-account-title">
      <button class="dialog-close" type="button" data-close-delete-account aria-label="Cerrar">×</button>
      <span class="delete-account-symbol">!</span>
      <span class="section-kicker">ACCIÓN IRREVERSIBLE</span>
      <h2 id="delete-account-title">Eliminar tu cuenta</h2>
      <p>Tu perfil y los datos asociados se eliminarán permanentemente. Algunos resultados históricos pueden conservar el nombre registrado para mantener la integridad competitiva.</p>
      <form class="delete-account-form" data-delete-account-form>
        <label>Confirma con tu contraseña<input name="password" type="password" autocomplete="current-password" required placeholder="Tu contraseña actual" /></label>
        <p class="delete-account-error" data-delete-account-error aria-live="polite"></p>
        <div><button class="button button--quiet" type="button" data-close-delete-account>Cancelar</button><button class="button button--danger" type="submit">Eliminar definitivamente</button></div>
      </form>
    </dialog>`;
}

function refreshCurrentUserAvatars() {
  if (!currentUser) return;
  const user = currentUser;
  root.querySelectorAll<HTMLElement>("[data-current-user-avatar]").forEach((slot) => {
    slot.innerHTML = avatarMarkup(user, slot.dataset.avatarClass || "avatar");
  });
}

function bindProfilePhotoDialog() {
  const dialog = root.querySelector<HTMLDialogElement>(".profile-photo-dialog");
  const input = dialog?.querySelector<HTMLInputElement>("[data-profile-photo-input]");
  const preview = dialog?.querySelector<HTMLElement>("[data-photo-preview]");
  const save = dialog?.querySelector<HTMLButtonElement>("[data-save-profile-photo]");
  const remove = dialog?.querySelector<HTMLButtonElement>("[data-remove-profile-photo]");
  const error = dialog?.querySelector<HTMLElement>("[data-profile-photo-error]");
  if (!dialog || !input || !preview || !save || !remove || !error || !currentUser) return;

  let selectedFile: File | null = null;
  let previewUrl: string | null = null;
  const originalSaveText = save.textContent || "Guardar foto";

  const clearPreviewUrl = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  };
  const resetDialog = () => {
    clearPreviewUrl();
    selectedFile = null;
    input.value = "";
    error.textContent = "";
    save.disabled = true;
    save.textContent = originalSaveText;
    remove.disabled = false;
    preview.innerHTML = avatarMarkup(currentUser!, "avatar avatar--profile");
    remove.hidden = !currentUser?.avatarUrl;
  };
  const closeDialog = () => {
    resetDialog();
    dialog.close();
  };

  root.querySelector("[data-open-profile-photo]")?.addEventListener("click", () => {
    resetDialog();
    dialog.showModal();
  });
  dialog.querySelector("[data-close-profile-photo]")?.addEventListener("click", closeDialog);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog();
  });
  dialog.querySelectorAll("[data-choose-profile-photo]").forEach((button) => {
    button.addEventListener("click", () => input.click());
  });
  input.addEventListener("change", () => {
    const file = input.files?.[0] ?? null;
    error.textContent = "";
    selectedFile = null;
    save.disabled = true;
    clearPreviewUrl();
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      error.textContent = "Selecciona una imagen JPG, PNG o WebP.";
      input.value = "";
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      error.textContent = "La foto no puede superar 8 MB.";
      input.value = "";
      return;
    }
    selectedFile = file;
    previewUrl = URL.createObjectURL(file);
    preview.innerHTML = `<img class="avatar avatar--profile" src="${escapeHtml(previewUrl)}" alt="Vista previa de tu nueva foto" />`;
    save.disabled = false;
  });
  save.addEventListener("click", async () => {
    if (!selectedFile) return;
    save.disabled = true;
    save.textContent = "Guardando…";
    error.textContent = "";
    try {
      const response = await api.updateAvatar(selectedFile);
      currentUser = { ...currentUser!, ...response.avatar };
      refreshCurrentUserAvatars();
      closeDialog();
      toast("Tu foto de perfil fue actualizada.");
    } catch (requestError) {
      error.textContent = errorMessage(requestError);
      save.disabled = false;
      save.textContent = originalSaveText;
    }
  });
  remove.addEventListener("click", async () => {
    remove.disabled = true;
    error.textContent = "";
    try {
      await api.removeAvatar();
      currentUser = { ...currentUser!, avatarUrl: null, avatarVersion: null };
      refreshCurrentUserAvatars();
      closeDialog();
      toast("La foto de perfil fue eliminada.");
    } catch (requestError) {
      error.textContent = errorMessage(requestError);
      remove.disabled = false;
    }
  });
  dialog.addEventListener("close", clearPreviewUrl);
}

function bindAccountDeletionDialog() {
  const dialog = root.querySelector<HTMLDialogElement>(".delete-account-dialog");
  const form = dialog?.querySelector<HTMLFormElement>("[data-delete-account-form]");
  const password = form?.querySelector<HTMLInputElement>('input[name="password"]');
  const error = form?.querySelector<HTMLElement>("[data-delete-account-error]");
  const submit = form?.querySelector<HTMLButtonElement>('[type="submit"]');
  if (!dialog || !form || !password || !error || !submit) return;
  const originalSubmitText = submit.textContent || "Eliminar definitivamente";
  const close = () => {
    if (dialog.open) dialog.close();
  };
  const reset = () => {
    form.reset();
    error.textContent = "";
    submit.disabled = false;
    submit.textContent = originalSubmitText;
  };

  root.querySelector("[data-open-delete-account]")?.addEventListener("click", () => {
    root.querySelector<HTMLDialogElement>(".profile-photo-dialog")?.close();
    reset();
    dialog.showModal();
    window.setTimeout(() => password.focus(), 0);
  });
  dialog.querySelectorAll("[data-close-delete-account]").forEach((button) => {
    button.addEventListener("click", close);
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener("close", reset);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const confirmation = password.value;
    if (!confirmation) {
      error.textContent = "Escribe tu contraseña para continuar.";
      password.focus();
      return;
    }
    error.textContent = "";
    submit.disabled = true;
    submit.textContent = "Eliminando cuenta…";
    try {
      await api.deleteAccount(confirmation);
      close();
      currentUser = null;
      applyPremiumStatus(false);
      currentRating = null;
      setSessionHint(false);
      socket?.disconnect();
      socket = null;
      navigate("/inicio");
      toast("Tu cuenta fue eliminada permanentemente.");
    } catch (requestError) {
      error.textContent = errorMessage(requestError);
      submit.disabled = false;
      submit.textContent = originalSubmitText;
      password.select();
    }
  });
}

function loadingMarkup(message = "Preparando la mesa…") {
  return `<div class="loading-state"><span class="loader"></span><p>${escapeHtml(message)}</p></div>`;
}

function renderLanding() {
  pageCleanup?.();
  pageCleanup = null;
  root.innerHTML = `
    <div class="landing">
      ${publicHeader()}
      <main>
        <section class="hero container">
          <div class="hero-copy">
            <span class="eyebrow"><i></i>Damas internacionales · 10×10</span>
            <h1>Piensa profundo.<br><em>Juega grande.</em></h1>
            <p>Partidas competitivas en tiempo real, reglas claras y un Elo Damas que refleja cada decisión sobre el tablero.</p>
            <div class="hero-actions">
              <button class="button button--primary button--large" data-open-auth="register">Jugar gratis ${icon("play")}</button>
              <button class="button button--outline button--large" data-open-auth="login">Ya tengo cuenta</button>
            </div>
            <div class="hero-facts">
              <span><b>10×10</b><small>Modalidad única</small></span>
              <span><b>10 · 30 · 60</b><small>Minutos por jugador</small></span>
              <span><b>En vivo</b><small>Actualización instantánea</small></span>
            </div>
          </div>
          <div class="hero-board-wrap" aria-hidden="true">
            <div class="hero-glow"></div>
            <div class="mini-board">${decorativeBoardMarkup()}</div>
            <div class="floating-card floating-card--rating"><span>${icon("ranking")}</span><small>Elo Damas</small><b>${(1428).toLocaleString(localeCode())} <i>+18</i></b></div>
            <div class="floating-card floating-card--clock"><span>${icon("clock")}</span><b>10:00</b><small>Partida rápida</small></div>
          </div>
        </section>
        <section class="feature-strip" id="como-jugar">
          <div class="container feature-grid">
            <article><span>01</span><div><b>Crea tu cuenta</b><p>Tu perfil y Elo Damas nacen en segundos.</p></div></article>
            <article><span>02</span><div><b>Elige tu reloj</b><p>Juega a 10, 30 o 60 minutos.</p></div></article>
            <article><span>03</span><div><b>Domina el tablero</b><p>Captura, corona y escala posiciones.</p></div></article>
          </div>
        </section>
        <section class="seo-content-section container" aria-labelledby="seo-home-title">
          <div><span class="section-kicker">JUEGA · APRENDE · COMPARTE</span><h2 id="seo-home-title">Damas internacionales 10×10 online</h2><p>King Damas es un espacio gratuito para jugar desde República Dominicana o cualquier lugar del mundo. Elige partidas rápidas de 10 minutos o controles de 30 y 60 minutos para pensar cada movimiento.</p><a class="button button--outline" href="/como-jugar">Aprender cómo jugar</a></div>
          <div class="seo-home-features"><article><b>Buscar rival</b><p>Encuentra un oponente de nivel similar y compite por Elo Damas.</p></article><article><b>Desafiar a un amigo</b><p>Comparte un enlace privado y juega una partida 10×10 en tiempo real.</p></article><article><b>Camino de Leyendas</b><p>Entrena capturas, estrategia y finales sin modificar tu clasificación.</p></article></div>
        </section>
      </main>
      ${publicFooterMarkup()}
      ${authDialogMarkup()}
    </div>`;
  bindNavigation();
  bindAuthDialog();
}

function isPasswordResetPath() {
  return window.location.pathname.replace(/\/+$/, "") === "/restablecer";
}

function passwordResetToken() {
  return new URLSearchParams(window.location.search).get("token")?.trim() || "";
}

function clearPasswordResetUrl() {
  const url = new URL(window.location.href);
  url.pathname = "/";
  url.search = "";
  url.hash = "/inicio";
  window.history.replaceState(window.history.state, "", url);
}

async function leavePasswordReset(openRecovery = false) {
  clearPasswordResetUrl();
  await renderRoute();
  if (!openRecovery || currentUser) return;
  root.querySelector<HTMLButtonElement>('[data-open-auth="login"]')?.click();
  root.querySelector<HTMLButtonElement>("[data-forgot-password]")?.click();
}

function renderPasswordReset(token: string) {
  const available = Boolean(token);
  root.innerHTML = `
    <div class="landing password-reset-landing">
      ${publicHeader()}
      <main class="password-reset-page">
        <section class="password-reset-card">
          <span class="password-reset-seal">${icon("crown")}</span>
          <span class="section-kicker">SEGURIDAD DE TU CUENTA</span>
          <h1>${available ? "Crea una nueva contraseña" : "Enlace no disponible"}</h1>
          <p>${available
            ? "Elige una contraseña segura de al menos 8 caracteres, con una letra y un número."
            : "Este enlace de recuperación no incluye un token válido. Solicita uno nuevo para continuar."}</p>
          ${available ? `<form class="password-reset-form" data-password-reset-form>
            <label>Nueva contraseña<input name="password" type="password" autocomplete="new-password" minlength="8" required placeholder="8 caracteres, una letra y un número" /></label>
            <label>Confirmar contraseña<input name="confirmation" type="password" autocomplete="new-password" minlength="8" required placeholder="Repite tu contraseña" /></label>
            <p class="form-error" data-password-reset-error aria-live="polite"></p>
            <button class="button button--primary button--wide" type="submit">Actualizar contraseña</button>
          </form>` : `<button class="button button--primary button--wide" type="button" data-request-new-reset>Solicitar un nuevo enlace</button>`}
          <button class="password-reset-home" type="button" data-password-reset-home>← Volver al inicio</button>
        </section>
      </main>
      ${authDialogMarkup()}
    </div>`;

  root.querySelector<HTMLElement>(".public-header [data-route]")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    void leavePasswordReset();
  }, { capture: true });
  bindNavigation();
  bindAuthDialog();
  root.querySelector("[data-password-reset-home]")?.addEventListener("click", () => void leavePasswordReset());
  root.querySelector("[data-request-new-reset]")?.addEventListener("click", () => void leavePasswordReset(true));

  const form = root.querySelector<HTMLFormElement>("[data-password-reset-form]");
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector<HTMLButtonElement>("[type=submit]");
    const error = form.querySelector<HTMLElement>("[data-password-reset-error]");
    const data = new FormData(form);
    const password = String(data.get("password") || "");
    const confirmation = String(data.get("confirmation") || "");
    if (error) error.textContent = "";
    if (password !== confirmation) {
      if (error) error.textContent = "Las contraseñas no coinciden.";
      return;
    }
    if (submit) {
      submit.disabled = true;
      submit.textContent = "Actualizando…";
    }
    try {
      const result = await api.resetPassword(token, password);
      const card = root.querySelector<HTMLElement>(".password-reset-card");
      if (!card) return;
      card.innerHTML = `<span class="password-reset-success">✓</span><span class="section-kicker">CONTRASEÑA ACTUALIZADA</span><h1>Tu acceso está listo</h1><p>${escapeHtml(result.message)} Ya puedes entrar con tu nueva contraseña.</p><button class="button button--primary button--wide" type="button" data-reset-complete>${currentUser ? "Ir al inicio" : "Iniciar sesión"}</button>`;
      card.querySelector("[data-reset-complete]")?.addEventListener("click", () => void leavePasswordReset(!currentUser));
    } catch (requestError) {
      if (error) error.textContent = errorMessage(requestError);
      if (submit) {
        submit.disabled = false;
        submit.textContent = "Actualizar contraseña";
      }
    }
  });
}

function authDialogMarkup() {
  return `
    <dialog class="auth-dialog">
      <button class="dialog-close" type="button" data-close-dialog aria-label="Cerrar">×</button>
      <div class="auth-brand brand">${logoMarkup()}</div>
      <div class="auth-tabs" role="tablist">
        <button type="button" class="is-active" data-auth-tab="login">Entrar</button>
        <button type="button" data-auth-tab="register">Crear cuenta</button>
      </div>
      <form class="auth-form" data-auth-form="login">
        <div class="form-intro"><h2>Qué bueno verte</h2><p>Entra y vuelve a tu próxima jugada.</p></div>
        <label>Usuario o correo<input name="identifier" autocomplete="username" required placeholder="tu_usuario" /></label>
        <label>Contraseña<input name="password" type="password" autocomplete="current-password" required placeholder="••••••••" /></label>
        <button class="auth-forgot-password" type="button" data-forgot-password>¿Olvidaste tu contraseña?</button>
        <p class="form-error" aria-live="polite"></p>
        <button class="button button--primary button--wide" type="submit">Entrar a la mesa</button>
      </form>
      <form class="auth-form is-hidden" data-auth-form="forgot">
        <div class="auth-recovery-fields" data-forgot-fields>
          <div class="form-intro"><h2>Recupera tu acceso</h2><p>Escribe el correo de tu cuenta y te enviaremos un enlace válido durante una hora.</p></div>
          <label>Correo electrónico<input name="email" type="email" autocomplete="email" required placeholder="tu@correo.com" /></label>
          <p class="form-error" aria-live="polite"></p>
          <button class="button button--primary button--wide" type="submit">Enviar enlace</button>
          <button class="auth-back-login" type="button" data-auth-back="login">← Volver a iniciar sesión</button>
        </div>
        <div class="auth-recovery-success" data-forgot-success hidden>
          <span>✓</span><h2>Revisa tu correo</h2><p data-forgot-success-message></p>
          <button class="button button--primary button--wide" type="button" data-auth-back="login">Volver a iniciar sesión</button>
        </div>
      </form>
      <form class="auth-form is-hidden" data-auth-form="register">
        <div class="form-intro"><h2>Únete a la mesa</h2><p>Crea tu perfil para competir en 10×10.</p></div>
        <div class="form-row">
          <label>Nombre<input name="name" autocomplete="name" minlength="2" maxlength="60" required placeholder="Tu nombre" /></label>
          <label>País<select name="countryCode" required><option value="DO">🇩🇴 R. Dominicana</option><option value="US">🇺🇸 Estados Unidos</option><option value="ES">🇪🇸 España</option><option value="CO">🇨🇴 Colombia</option><option value="MX">🇲🇽 México</option><option value="VE">🇻🇪 Venezuela</option><option value="CU">🇨🇺 Cuba</option><option value="PR">🇵🇷 Puerto Rico</option></select></label>
        </div>
        <label>Usuario<input name="username" autocomplete="username" minlength="3" maxlength="24" pattern="[a-zA-Z0-9_]+" required placeholder="estratega10" /></label>
        <label>Correo<input name="email" type="email" autocomplete="email" required placeholder="tu@correo.com" /></label>
        <label>Contraseña<input name="password" type="password" autocomplete="new-password" minlength="8" required placeholder="8 caracteres, una letra y un número" /></label>
        <p class="form-error" aria-live="polite"></p>
        <button class="button button--primary button--wide" type="submit">Crear mi cuenta</button>
      </form>
    </dialog>`;
}

function bindAuthDialog() {
  const dialog = root.querySelector<HTMLDialogElement>(".auth-dialog");
  if (!dialog) return;
  const setTab = (tab: "login" | "register" | "forgot") => {
    dialog.querySelectorAll<HTMLElement>("[data-auth-tab]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.authTab === tab);
    });
    dialog.querySelectorAll<HTMLElement>("[data-auth-form]").forEach((form) => {
      form.classList.toggle("is-hidden", form.dataset.authForm !== tab);
    });
  };
  root.querySelectorAll<HTMLButtonElement>("[data-open-auth]").forEach((button) => {
    button.addEventListener("click", () => {
      setTab(button.dataset.openAuth === "register" ? "register" : "login");
      dialog.showModal();
    });
  });
  dialog.querySelector("[data-close-dialog]")?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.querySelectorAll<HTMLButtonElement>("[data-auth-tab]").forEach((button) => {
    button.addEventListener("click", () => setTab(button.dataset.authTab as "login" | "register"));
  });
  dialog.querySelector("[data-forgot-password]")?.addEventListener("click", () => setTab("forgot"));
  dialog.querySelectorAll("[data-auth-back=login]").forEach((button) => {
    button.addEventListener("click", () => setTab("login"));
  });
  dialog.querySelectorAll<HTMLFormElement>(".auth-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const mode = form.dataset.authForm;
      const submit = form.querySelector<HTMLButtonElement>("[type=submit]");
      const error = form.querySelector<HTMLElement>(".form-error");
      const data = new FormData(form);
      if (submit) {
        submit.disabled = true;
        submit.textContent = mode === "forgot"
          ? "Enviando…"
          : mode === "login"
            ? "Entrando…"
            : "Creando cuenta…";
      }
      if (error) error.textContent = "";
      try {
        if (mode === "forgot") {
          const result = await api.forgotPassword(String(data.get("email")));
          const fields = form.querySelector<HTMLElement>("[data-forgot-fields]");
          const success = form.querySelector<HTMLElement>("[data-forgot-success]");
          const message = form.querySelector<HTMLElement>("[data-forgot-success-message]");
          if (fields) fields.hidden = true;
          if (success) success.hidden = false;
          if (message) message.textContent = result.message;
          return;
        }
        const response = mode === "login"
          ? await api.login(String(data.get("identifier")), String(data.get("password")))
          : await api.register({
              name: String(data.get("name")),
              username: String(data.get("username")),
              email: String(data.get("email")),
              countryCode: String(data.get("countryCode")),
              password: String(data.get("password")),
            });
        currentUser = response.user;
        applyPremiumStatus(Boolean(response.user.premium?.active), response.user.premium?.expiresAt || null);
        setSessionHint(true);
        dialog.close();
        if (isPasswordResetPath()) clearPasswordResetUrl();
        navigate("/inicio");
        scheduleBackgroundServices(response.user, 500);
        toast(`Bienvenido, ${currentUser.name}.`);
      } catch (requestError) {
        if (error) error.textContent = errorMessage(requestError);
      } finally {
        if (submit) {
          submit.disabled = false;
          submit.textContent = mode === "forgot"
            ? "Enviar enlace"
            : mode === "login"
              ? "Entrar a la mesa"
              : "Crear mi cuenta";
        }
      }
    });
  });
}

async function renderDashboard() {
  root.innerHTML = appLayout(loadingMarkup("Cargando tu mesa…"));
  bindNavigation();
  try {
    const [ratingResponse, leaderboardResponse] = await Promise.all([
      api.myRatings(),
      api.leaderboard("DO"),
    ]);
    const rating = ratingResponse.ratings.find((item) => item.boardSize === 10) ?? ratingResponse.ratings[0];
    currentRating = rating ?? null;
    const ranking = leaderboardResponse.players.slice(0, 5);
    root.innerHTML = appLayout(dashboardMarkup(rating, ranking), "home");
    bindNavigation();
  } catch (error) {
    root.innerHTML = appLayout(errorState(errorMessage(error)));
    bindNavigation();
    bindRetry(() => renderDashboard());
  }
}

async function renderPlayPage() {
  root.innerHTML = appLayout(loadingMarkup("Preparando la mesa…"), "game");
  bindNavigation();
  try {
    const ratingResponse = await api.myRatings();
    const rating = ratingResponse.ratings.find((item) => item.boardSize === 10) ?? ratingResponse.ratings[0];
    currentRating = rating ?? null;
    root.innerHTML = appLayout(playPageMarkup(rating), "game");
    bindNavigation();
    bindPlayPage();
  } catch (error) {
    root.innerHTML = appLayout(errorState(errorMessage(error)), "game");
    bindNavigation();
    bindRetry(() => renderPlayPage());
  }
}

function dashboardMarkup(rating: Rating | undefined, leaders: LeaderboardPlayer[]) {
  const value = rating?.rating ?? 1200;
  const games = rating?.gamesPlayed ?? 0;
  const wins = rating?.wins ?? 0;
  const winRate = games ? Math.round((wins / games) * 100) : 0;
  return `
    <section class="dashboard-heading">
      <div><span class="eyebrow"><i></i>RESUMEN PERSONAL</span><h1 class="dashboard-greeting"><span>Hola, ${escapeHtml(currentUser?.name.split(" ")[0])}</span>${currentUser ? worldTrophyMarkup(currentUser, "world-trophy--heading") : ""}</h1>${currentUser ? worldTitleRecognitionMarkup(currentUser, "world-title-recognition--heading") : ""}<p>Este es tu recorrido actual en Elo Damas.</p></div>
      <div class="rating-card"><span>${icon("ranking")}</span><div><small>Tu Elo Damas</small><b>${value.toLocaleString(localeCode())}</b><em>${escapeHtml(rating?.tier ?? eloTier(value))}</em></div></div>
    </section>
    <div class="dashboard-grid">
      <section class="panel home-next-game">
        <div><span class="section-kicker">TU PRÓXIMA DECISIÓN</span><h2>La mesa está lista cuando tú lo estés.</h2><p>Compite, recorre el Camino de Leyendas o estudia partidas de otros jugadores.</p><div class="home-next-actions"><button class="button button--primary" type="button" data-route="/jugar">${icon("play")} Ir a Jugar</button><button class="button button--outline" type="button" data-route="/en-vivo">${icon("eye")} Ver en vivo</button></div></div>
        <div class="home-mode-card"><span>${brandMarkMarkup()}</span><small>MODALIDAD OFICIAL</small><b>10 × 10</b><em>10 · 30 · 60 minutos</em></div>
      </section>
      <aside class="panel stats-panel">
        <div class="panel-heading"><div><span class="section-kicker">TU TEMPORADA</span><h2>Resumen</h2></div></div>
        <div class="stat-ring" style="--progress:${winRate * 3.6}deg"><div><b>${winRate}%</b><small>victorias</small></div></div>
        <div class="stats-row"><span><b>${games}</b><small>Partidas</small></span><span><b>${wins}</b><small>Victorias</small></span><span><b>${rating?.draws ?? 0}</b><small>Tablas</small></span></div>
        <p class="stats-hint">${games ? "Sigue jugando para consolidar tu posición." : "Tu primera partida establecerá el inicio de tu recorrido."}</p>
      </aside>
    </div>
    <section class="panel ranking-preview">
      <div class="panel-heading"><div><span class="section-kicker">TABLA NACIONAL</span><h2>Mejores de República Dominicana</h2></div><button class="text-button" data-route="/clasificacion">Ver clasificación completa →</button></div>
      ${leaderboardTable(leaders, true)}
    </section>`;
}

function playPageMarkup(rating: Rating | undefined) {
  const value = rating?.rating ?? 1200;
  return `
    <section class="page-heading play-page-heading">
      <div><span class="eyebrow"><i></i>ENTRA A LA MESA</span><h1>Jugar</h1><p>Configura el reloj y decide a quién quieres enfrentarte.</p></div>
      <div class="rating-card"><span>${icon("ranking")}</span><div><small>Competirás con</small><b>${value.toLocaleString(localeCode())}</b><em>${escapeHtml(rating?.tier ?? eloTier(value))}</em></div></div>
    </section>
    <div class="play-page-layout">
      <section class="panel play-panel play-setup-panel">
        <div class="panel-heading"><div><span class="section-kicker">CONFIGURACIÓN DE PARTIDA</span><h2>Elige tu ritmo</h2></div><span class="mode-pill">10 × 10</span></div>
        <div class="time-options" role="radiogroup" aria-label="Tiempo por jugador">
          ${TIME_CONTROLS.map((minutes) => `<button type="button" role="radio" aria-checked="${minutes === selectedTime}" class="time-option ${minutes === selectedTime ? "is-selected" : ""}" data-time="${minutes}"><span>${icon("clock")}</span><b>${minutes}</b><small>minutos</small><em>${minutes === 10 ? "Rápida" : minutes === 30 ? "Clásica" : "Profunda"}</em></button>`).join("")}
        </div>
        <div class="play-summary"><span><i class="status-dot"></i>Emparejamiento por Elo Damas</span><span>Captura obligatoria · Dama voladora</span></div>
        <div class="play-actions">
          <button class="button button--legend button--play" type="button" data-challenge-legend>${icon("crown")} Camino de Leyendas</button>
          <button class="button button--outline button--play" type="button" data-challenge-friend>${icon("link")} Desafiar a un amigo</button>
          <button class="button button--primary button--play" type="button" data-find-match>${icon("play")} Buscar rival</button>
        </div>
      </section>
      <aside class="panel play-guide-panel">
        <span class="play-guide-seal">${icon("play")}</span>
        <span class="section-kicker">TU SELECCIÓN</span>
        <h2><b data-selected-time>${selectedTime}</b> minutos</h2>
        <p>Tiempo disponible para cada jugador.</p>
        <ul>
          <li><span>01</span><p><b>Buscar rival</b><small>Partida clasificada con emparejamiento por Elo.</small></p></li>
          <li><span>02</span><p><b>Desafiar a un amigo</b><small>Genera un enlace privado para compartir.</small></p></li>
          <li><span>03</span><p><b>Camino de Leyendas</b><small>Práctica progresiva que no modifica tu Elo.</small></p></li>
        </ul>
        <button class="text-button" type="button" data-route="/en-vivo">${icon("eye")} Prefiero observar una partida</button>
      </aside>
    </div>
    <div class="matchmaking-modal" aria-live="polite" aria-hidden="true">
      <div class="search-visual"><span class="search-ring search-ring--one"></span><span class="search-ring search-ring--two"></span>${brandMarkMarkup()}</div>
      <span class="section-kicker">EMPAREJAMIENTO 10×10</span>
      <h2>Buscando un buen rival</h2>
      <p>Comparando tu Elo Damas con jugadores disponibles.</p>
      <b class="search-time">00:00</b>
      <small class="search-detail">Rango inicial ±100 · posición 1</small>
      <button class="button button--outline" type="button" data-cancel-match>Cancelar búsqueda</button>
    </div>
    <div class="friend-invite-modal" aria-live="polite" aria-hidden="true">
      <button class="dialog-close" type="button" data-cancel-friend aria-label="Cancelar invitación">×</button>
      <span class="invite-seal">${icon("link")}</span>
      <span class="section-kicker">DESAFÍO PRIVADO · 10×10</span>
      <h2>Invita a un amigo</h2>
      <p>Comparte este enlace. La primera persona que lo acepte jugará contigo a <strong data-invite-time>${selectedTime} minutos</strong>.</p>
      <div class="invite-share-preview" data-invite-share-preview></div>
      <label class="share-link-field"><span>Enlace de invitación</span><span><input readonly data-invite-url aria-label="Enlace de invitación" /><button type="button" data-copy-invite aria-label="Copiar enlace">${icon("copy")}</button></span></label>
      <div class="invite-actions"><button class="button button--primary" type="button" data-share-invite>${icon("share")} Compartir desafío</button><button class="button button--quiet" type="button" data-copy-invite-text>${icon("copy")} Copiar mensaje</button></div>
      <div class="invite-wait"><i class="status-dot"></i><span><b>Esperando a tu amigo…</b><small>El enlace vence en 60 minutos</small></span></div>
      <p class="friend-invite-error"></p>
      <button class="text-button text-button--danger" type="button" data-cancel-friend>Cancelar invitación</button>
    </div>
    <div class="modal-backdrop" data-match-backdrop></div>`;
}

function bindPlayPage() {
  root.querySelectorAll<HTMLButtonElement>("[data-time]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedTime = Number(button.dataset.time) as TimeControl;
      root.querySelectorAll<HTMLButtonElement>("[data-time]").forEach((item) => {
        const selected = item === button;
        item.classList.toggle("is-selected", selected);
        item.setAttribute("aria-checked", String(selected));
      });
      const selectedTimeLabel = root.querySelector<HTMLElement>("[data-selected-time]");
      if (selectedTimeLabel) selectedTimeLabel.textContent = String(selectedTime);
    });
  });
  root.querySelector("[data-find-match]")?.addEventListener("click", () => void startMatchmaking());
  root.querySelector("[data-cancel-match]")?.addEventListener("click", () => void stopMatchmaking(true));
  root.querySelector("[data-challenge-friend]")?.addEventListener("click", () => void createFriendChallenge());
  root.querySelector("[data-challenge-legend]")?.addEventListener("click", () => navigate(`/leyendas/${selectedTime}`));
}

async function confirmAndFinishNativeTransaction(
  transaction: NativeStoreTransaction,
) {
  const pending = nativeStoreConfirmations.get(transaction.transactionId);
  if (pending) return pending;
  const confirmation = (async () => {
    const result = await api.confirmAppStoreTransaction(
      transaction.signedTransactionInfo,
    );
    if (result.status !== "COMPLETED") {
      throw new Error("App Store no pudo confirmar la compra.");
    }
    await finishNativeStoreTransaction(transaction.transactionId);
  })().finally(() => {
    nativeStoreConfirmations.delete(transaction.transactionId);
  });
  nativeStoreConfirmations.set(transaction.transactionId, confirmation);
  return confirmation;
}

async function initializeNativeStoreForUser(user: User) {
  if (!isIOSNativeApp()) return;
  if (!nativeStoreListenerBound) {
    nativeStoreListenerBound = true;
    await listenForNativeStoreTransactions((transaction) => {
      void confirmAndFinishNativeTransaction(transaction).catch((error) => {
        console.warn("La compra pendiente de App Store todavía no pudo confirmarse.", error);
      });
    }).catch((error) => {
      nativeStoreListenerBound = false;
      console.warn("No se pudo escuchar las compras de App Store.", error);
    });
  }
  if (nativeStoreRecoveryUserId === user.id) return;
  nativeStoreRecoveryUserId = user.id;
  try {
    const config = await api.appStoreConfig();
    const subscription = await nativeSubscriptionStatus();
    await syncAccountPremium(subscription, config.appAccountToken);
    const ads = await nativeAdsStatus();
    nativeAdPrivacyOptionsRequired = Boolean(ads?.privacyOptionsRequired);
    if (config.enabled) {
      const transactions = await unfinishedNativeStoreTransactions();
      for (const transaction of transactions) {
        await confirmAndFinishNativeTransaction(transaction);
      }
    }
  } catch (error) {
    console.warn("La recuperación de compras de App Store queda pendiente.", error);
  }
}

function showGameCompletionAd() {
  if (!isIOSNativeApp()) return;
  window.setTimeout(() => {
    void (async () => {
      try {
        const { premium } = await api.premiumStatus();
        applyPremiumStatus(premium.active, premium.expiresAt);
        await setNativeAdsPremiumStatus(premium.active);
        if (!premium.active) await showNativeGameInterstitial();
      } catch (error) {
        // Si el derecho no puede confirmarse, no arriesgamos mostrar publicidad
        // a una cuenta que podría ser Premium.
        console.warn("El anuncio de fin de partida no estuvo disponible.", error);
      }
    })();
  }, 350);
}

async function loadPayPalSdk(clientId: string, currency: string) {
  if (window.paypal) return window.paypal;
  if (paypalSdkPromise) return paypalSdkPromise;
  paypalSdkPromise = new Promise<PayPalNamespace>((resolve, reject) => {
    const script = document.createElement("script");
    const parameters = new URLSearchParams({
      "client-id": clientId,
      currency,
      intent: "capture",
      components: "buttons",
      locale: "es_DO",
    });
    script.src = `https://www.paypal.com/sdk/js?${parameters.toString()}`;
    script.async = true;
    script.dataset.paypalSdk = "true";
    script.addEventListener("load", () => {
      if (window.paypal) resolve(window.paypal);
      else reject(new Error("PayPal no pudo iniciar."));
    });
    script.addEventListener("error", () => {
      paypalSdkPromise = null;
      reject(new Error("No pudimos conectar con PayPal."));
    });
    document.head.append(script);
  });
  return paypalSdkPromise;
}

function donationMarkup(config: Awaited<ReturnType<typeof api.donationConfig>>) {
  const presetAmounts = [3, 5, 10, 25];
  return `
    <section class="page-heading donation-heading">
      <div><span class="eyebrow"><i></i>APOYA KING DAMAS</span><h1>Ayuda a mantener<br>las mesas abiertas</h1><p>Tu aporte sostiene los servidores y el desarrollo continuo de la plataforma.</p></div>
      <span class="donation-heart">${icon("heart")}</span>
    </section>
    <div class="donation-layout">
      <section class="panel donation-card">
        <div class="panel-heading"><div><span class="section-kicker">APORTE VOLUNTARIO</span><h2>Elige cuánto donar</h2></div><span class="donation-currency">USD</span></div>
        ${config.enabled ? `
          <div class="donation-amounts" role="radiogroup" aria-label="Monto de la donación">
            ${presetAmounts.map((amount) => `<button type="button" class="donation-amount ${amount === 5 ? "is-selected" : ""}" role="radio" aria-checked="${amount === 5}" data-donation-amount="${amount}"><small>USD</small><b>$${amount}</b></button>`).join("")}
          </div>
          <label class="custom-donation"><span>Otro monto</span><span><i>$</i><input type="number" min="${config.minAmount}" max="${config.maxAmount}" step="0.01" inputmode="decimal" placeholder="1.00 – 500.00" data-custom-donation /></span></label>
          <p class="donation-error" data-donation-error aria-live="polite"></p>
          <div class="paypal-button-container" data-paypal-button><span class="loader loader--small"></span><small>Preparando pago seguro…</small></div>
          <div class="payment-security"><span>🔒</span><p><b>Pago procesado por PayPal</b><small>King Damas no recibe ni almacena tus datos bancarios.</small></p></div>
        ` : `
          <div class="donation-unavailable"><span>${icon("heart")}</span><h3>Donaciones temporalmente no disponibles</h3><p>Estamos terminando de configurar PayPal. Podrás apoyar el proyecto desde aquí muy pronto.</p></div>
        `}
      </section>
      <aside class="panel donation-purpose">
        <img src="/brand/icon-192.png?v=piece-1" alt="" />
        <span class="section-kicker">¿A DÓNDE VA TU APORTE?</span>
        <h2>Una mejor mesa para todos</h2>
        <ul>
          <li><span>01</span><p><b>Servidores estables</b><small>Partidas rápidas y conexión en tiempo real.</small></p></li>
          <li><span>02</span><p><b>Mejoras continuas</b><small>Nuevas funciones y una experiencia más pulida.</small></p></li>
          <li><span>03</span><p><b>Comunidad competitiva</b><small>Un espacio gratuito para jugadores de damas.</small></p></li>
        </ul>
        <p class="donation-fair-play">La donación es opcional y no modifica tu Elo Damas ni ofrece ventajas en las partidas.</p>
      </aside>
    </div>`;
}

function iosSupportMarkup(
  config: AppStoreConfig,
  products: NativeStoreProduct[],
  subscriptionActive: boolean,
) {
  const productById = new Map(products.map((product) => [product.id, product]));
  const adFreePlanLabels: Record<AppStoreConfig["products"]["adFree"][number]["interval"], string> = {
    weekly: "Semanal",
    monthly: "Mensual",
    annual: "Anual",
  };
  const adFreePlans = config.products.adFree
    .map(({ productId, interval }) => ({ product: productById.get(productId), interval }))
    .filter((plan) => Boolean(plan.product)) as Array<{
      product: NativeStoreProduct;
      interval: AppStoreConfig["products"]["adFree"][number]["interval"];
    }>;
  const available = config.enabled && Boolean(config.appAccountToken) && products.length > 0;
  return `
    <section class="page-heading donation-heading">
      <div><span class="eyebrow"><i></i>APOYA KING DAMAS</span><h1>Ayuda a mantener<br>las mesas abiertas</h1><p>Tu aporte voluntario sostiene la continuidad y las mejoras de King Damas.</p></div>
      <span class="donation-heart">${icon("heart")}</span>
    </section>
    <div class="donation-layout">
      <section class="panel donation-card">
        <section class="ios-ad-free-card ${subscriptionActive ? "is-active" : ""}">
          <span class="ios-ad-free-icon">${subscriptionActive ? "✓" : "♢"}</span>
          <div><small class="section-kicker">CUENTA PREMIUM</small><h2>${subscriptionActive ? "Disfrutas King Damas sin anuncios" : "Sin anuncios en todas tus plataformas"}</h2><p>${subscriptionActive ? "Tu cuenta King Damas es Premium en iOS, Android y web." : "Elimina los anuncios en iOS, Android y web con la misma cuenta de King Damas. Elige el plan que prefieras; se renueva automáticamente hasta que lo canceles."}</p></div>
          ${subscriptionActive
            ? `<button class="button button--quiet button--small" type="button" data-manage-ad-free>Administrar suscripción</button><button class="text-button" type="button" data-restore-ad-free>Restaurar compras</button>`
            : adFreePlans.length && config.appAccountToken
              ? `<div class="ios-ad-free-plans">${adFreePlans.map(({ product, interval }) => `<button class="button button--outline ios-ad-free-plan" type="button" data-buy-ad-free="${escapeHtml(product.id)}"><small>${adFreePlanLabels[interval]}</small><b>${escapeHtml(product.displayPrice)}</b></button>`).join("")}</div><button class="text-button" type="button" data-restore-ad-free>Restaurar compra</button>`
              : `<small class="ios-ad-free-unavailable">La suscripción estará disponible cuando App Store termine de configurarla.</small>`}
          <small class="ios-subscription-terms">El pago se cargará a tu Apple ID. La renovación automática puede cancelarse desde la configuración de suscripciones de App Store al menos 24 horas antes del próximo cobro. Consulta <a href="/terminos-y-condiciones">Términos</a> y <a href="/politica-de-privacidad">Privacidad</a>.</small>
          <p class="donation-error" data-ad-free-error aria-live="polite"></p>
        </section>
        <div class="panel-heading"><div><span class="section-kicker">APORTE VOLUNTARIO</span><h2>Elige una opción de apoyo</h2></div><span class="donation-currency">APP STORE</span></div>
        ${available ? `
          <div class="donation-amounts ios-support-options">
            ${config.products.support.map(({ productId }) => {
              const product = productById.get(productId);
              if (!product) return "";
              return `<button type="button" class="donation-amount ios-support-product" data-ios-support-product="${escapeHtml(product.id)}"><small>${escapeHtml(product.displayName)}</small><b>${escapeHtml(product.displayPrice)}</b></button>`;
            }).join("")}
          </div>
          <p class="donation-error" data-donation-error aria-live="polite"></p>
          <div class="payment-security"><span></span><p><b>Compra procesada por App Store</b><small>Apple gestiona el cobro con tu cuenta; King Damas no recibe tus datos de pago.</small></p></div>
        ` : `
          <div class="donation-unavailable"><span>${icon("heart")}</span><h3>Aportes temporalmente no disponibles</h3><p>Las compras de App Store todavía no están configuradas para esta versión.</p></div>
        `}
      </section>
      <aside class="panel donation-purpose">
        <img src="/brand/icon-192.png?v=piece-1" alt="" />
        <span class="section-kicker">¿A DÓNDE VA TU APORTE?</span>
        <h2>Una mejor mesa para todos</h2>
        <ul>
          <li><span>01</span><p><b>Servicio estable</b><small>Partidas rápidas y conexión en tiempo real.</small></p></li>
          <li><span>02</span><p><b>Mejoras continuas</b><small>Nuevas funciones y una experiencia más pulida.</small></p></li>
          <li><span>03</span><p><b>Comunidad competitiva</b><small>Un espacio gratuito para jugadores de damas.</small></p></li>
        </ul>
        <p class="donation-fair-play">El aporte es opcional, no desbloquea contenido y no modifica tu Elo Damas ni ofrece ventajas en las partidas.</p>
        ${nativeAdPrivacyOptionsRequired ? `<button class="text-button ios-ad-privacy" type="button" data-ad-privacy-options>Opciones de privacidad de anuncios</button>` : ""}
      </aside>
    </div>`;
}

function bindIOSSupport(config: AppStoreConfig) {
  const error = root.querySelector<HTMLElement>("[data-donation-error]");
  const buttons = [
    ...root.querySelectorAll<HTMLButtonElement>("[data-ios-support-product]"),
  ];
  const setDisabled = (disabled: boolean) => {
    buttons.forEach((button) => { button.disabled = disabled; });
  };
  if (error && config.appAccountToken && buttons.length) buttons.forEach((button) => {
    button.addEventListener("click", async () => {
      const productId = button.dataset.iosSupportProduct;
      if (!productId || !config.appAccountToken) return;
      error.textContent = "";
      setDisabled(true);
      try {
        const result = await purchaseNativeStoreProduct(
          productId,
          config.appAccountToken,
        );
        if (result.state === "cancelled") {
          setDisabled(false);
          toast("El aporte fue cancelado; no se realizó ningún cargo.", "error");
          return;
        }
        if (result.state === "pending") {
          error.textContent = "La compra espera aprobación de App Store. Se confirmará automáticamente.";
          return;
        }
        if (!result.transaction) return;
        try {
          await confirmAndFinishNativeTransaction(result.transaction);
        } catch (confirmationError) {
          error.textContent = "Apple confirmó la compra, pero aún debemos acreditarla. La reintentaremos automáticamente; no vuelvas a comprar.";
          console.warn("La confirmación del aporte quedó pendiente.", confirmationError);
          return;
        }
        const card = root.querySelector<HTMLElement>(".donation-card");
        if (card) {
          card.innerHTML = `<div class="donation-success"><span>✓</span><small class="section-kicker">APORTE COMPLETADO</small><h2>Gracias por apoyar King Damas</h2><p>Tu aporte voluntario fue confirmado por App Store.</p><button class="button button--primary" type="button" data-route="/inicio">Volver al inicio</button></div>`;
          bindNavigation();
        }
        toast("¡Gracias por apoyar King Damas!");
      } catch (purchaseError) {
        error.textContent = errorMessage(purchaseError);
        setDisabled(false);
      }
    });
  });

  const subscriptionError = root.querySelector<HTMLElement>("[data-ad-free-error]");
  const subscribeButtons = [
    ...root.querySelectorAll<HTMLButtonElement>("[data-buy-ad-free]"),
  ];
  const restoreButton = root.querySelector<HTMLButtonElement>("[data-restore-ad-free]");
  const manageButton = root.querySelector<HTMLButtonElement>("[data-manage-ad-free]");
  subscribeButtons.forEach((subscribeButton) => {
    subscribeButton.addEventListener("click", async () => {
      if (!config.appAccountToken || !subscribeButton.dataset.buyAdFree) return;
      subscribeButtons.forEach((button) => { button.disabled = true; });
      if (subscriptionError) subscriptionError.textContent = "";
      try {
        const result = await purchaseNativeSubscription(
          subscribeButton.dataset.buyAdFree,
          config.appAccountToken,
        );
        if (result.state === "cancelled") {
          subscribeButtons.forEach((button) => { button.disabled = false; });
          return;
        }
        if (result.state === "pending") {
          subscribeButtons.forEach((button) => { button.disabled = false; });
          if (subscriptionError) subscriptionError.textContent = "La suscripción espera aprobación de App Store.";
          return;
        }
        if (result.state !== "purchased" || !result.subscription) {
          subscribeButtons.forEach((button) => { button.disabled = false; });
          return;
        }
        await syncAccountPremium(result.subscription, config.appAccountToken, true);
        toast("Suscripción sin anuncios activada.");
        await renderDonation();
      } catch (subscriptionPurchaseError) {
        subscribeButtons.forEach((button) => { button.disabled = false; });
        if (subscriptionError) subscriptionError.textContent = errorMessage(subscriptionPurchaseError);
      }
    });
  });
  restoreButton?.addEventListener("click", async () => {
    restoreButton.disabled = true;
    if (subscriptionError) subscriptionError.textContent = "";
    try {
      const status = await restoreNativeSubscriptions();
      const premium = await syncAccountPremium(status, config.appAccountToken, true);
      toast(premium.active ? "Suscripción sin anuncios restaurada." : "No encontramos una suscripción activa.", premium.active ? "success" : "error");
      await renderDonation();
    } catch (restoreError) {
      restoreButton.disabled = false;
      if (subscriptionError) subscriptionError.textContent = errorMessage(restoreError);
    }
  });
  manageButton?.addEventListener("click", async () => {
    manageButton.disabled = true;
    try {
      await manageNativeSubscriptions();
    } catch (manageError) {
      toast(errorMessage(manageError), "error");
    } finally {
      manageButton.disabled = false;
    }
  });
  root.querySelector("[data-ad-privacy-options]")?.addEventListener("click", () => {
    void showNativeAdPrivacyOptions().catch((privacyError) => {
      toast(errorMessage(privacyError), "error");
    });
  });
}

async function renderDonation() {
  root.innerHTML = appLayout(loadingMarkup("Preparando el espacio de donación…"), "donate");
  bindNavigation();
  try {
    if (isIOSNativeApp()) {
      const config = await api.appStoreConfig();
      const products = config.enabled
        ? await nativeStoreProducts(
            [
              ...config.products.support.map((product) => product.productId),
              ...config.products.adFree.map((product) => product.productId),
            ],
          )
        : [];
      const subscription = await nativeSubscriptionStatus();
      const premium = await syncAccountPremium(subscription, config.appAccountToken);
      const ads = await nativeAdsStatus();
      nativeAdPrivacyOptionsRequired = Boolean(ads?.privacyOptionsRequired);
      root.innerHTML = appLayout(iosSupportMarkup(config, products, premium.active), "donate");
      bindNavigation();
      bindIOSSupport(config);
      return;
    }
    const config = await api.donationConfig();
    root.innerHTML = appLayout(donationMarkup(config), "donate");
    bindNavigation();
    if (!config.enabled || !config.clientId) return;
    await bindDonation(config);
  } catch (error) {
    root.innerHTML = appLayout(errorState(errorMessage(error)), "donate");
    bindNavigation();
    bindRetry(() => renderDonation());
  }
}

async function bindDonation(config: Awaited<ReturnType<typeof api.donationConfig>>) {
  const container = root.querySelector<HTMLElement>("[data-paypal-button]");
  const custom = root.querySelector<HTMLInputElement>("[data-custom-donation]");
  const error = root.querySelector<HTMLElement>("[data-donation-error]");
  if (!container || !custom || !error || !config.clientId) return;

  let amount = 5;
  const setError = (message = "") => { error.textContent = message; };
  root.querySelectorAll<HTMLButtonElement>("[data-donation-amount]").forEach((button) => {
    button.addEventListener("click", () => {
      amount = Number(button.dataset.donationAmount);
      custom.value = "";
      setError();
      root.querySelectorAll<HTMLButtonElement>("[data-donation-amount]").forEach((item) => {
        const selected = item === button;
        item.classList.toggle("is-selected", selected);
        item.setAttribute("aria-checked", String(selected));
      });
    });
  });
  custom.addEventListener("input", () => {
    amount = Number(custom.value);
    setError();
    root.querySelectorAll<HTMLButtonElement>("[data-donation-amount]").forEach((item) => {
      item.classList.remove("is-selected");
      item.setAttribute("aria-checked", "false");
    });
  });

  try {
    const paypal = await loadPayPalSdk(config.clientId, config.currency);
    if (route() !== "/donar" || !container.isConnected) return;
    container.innerHTML = "";
    const buttons = paypal.Buttons({
      style: { layout: "vertical", color: "gold", shape: "rect", label: "paypal", height: 45 },
      createOrder: async () => {
        if (!Number.isFinite(amount) || amount < config.minAmount || amount > config.maxAmount) {
          const message = `Elige un monto entre $${config.minAmount} y $${config.maxAmount}.`;
          setError(message);
          throw new Error(message);
        }
        setError();
        return (await api.createDonationOrder(amount)).id;
      },
      onApprove: async ({ orderID }) => {
        const result = await api.captureDonationOrder(orderID);
        if (result.status !== "COMPLETED") {
          throw new Error("PayPal no pudo confirmar la donación.");
        }
        const card = root.querySelector<HTMLElement>(".donation-card");
        if (card) {
          card.innerHTML = `<div class="donation-success"><span>✓</span><small class="section-kicker">DONACIÓN COMPLETADA</small><h2>Gracias por apoyar King Damas</h2><p>Tu aporte nos ayuda a mantener la comunidad jugando y creciendo.</p><button class="button button--primary" type="button" data-route="/inicio">Volver al inicio</button></div>`;
          bindNavigation();
        }
        toast("¡Gracias por apoyar King Damas!");
      },
      onCancel: () => toast("La donación fue cancelada; no se realizó ningún cargo.", "error"),
      onError: (paymentError) => {
        setError(errorMessage(paymentError));
      },
    });
    await buttons.render(container);
    pageCleanup = () => buttons.close?.();
  } catch (sdkError) {
    container.innerHTML = `<div class="donation-sdk-error"><b>PayPal no está disponible ahora mismo.</b><small>Revisa tu conexión e inténtalo nuevamente.</small></div>`;
    setError(errorMessage(sdkError));
  }
}

function creditLicense(label: string, url: string) {
  return `<a class="credit-license" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)} <span aria-hidden="true">↗</span></a>`;
}

function renderCredits() {
  const movement = AUDIO_CREDITS.effects.movement;
  const capture = AUDIO_CREDITS.effects.capture;
  root.innerHTML = appLayout(`
    <section class="page-heading credits-heading">
      <div><span class="eyebrow"><i></i>AUTORES Y RECURSOS</span><h1>Créditos</h1><p>Reconocemos a quienes aportaron la música, los efectos y los recursos visuales que acompañan cada partida.</p></div>
      <span class="credits-seal" aria-hidden="true">©</span>
    </section>
    <section class="credits-grid">
      <article class="credit-card credit-card--music">
        <header><span>♫</span><small>MÚSICA DE FONDO</small></header>
        <h2>${escapeHtml(AUDIO_CREDITS.title)}</h2>
        <p>La pieza ambiental que acompaña las partidas de Elo Damas.</p>
        <a class="credit-author" href="${escapeHtml(AUDIO_CREDITS.creatorUrl)}" target="_blank" rel="noreferrer"><span><small>AUTOR</small><b>${escapeHtml(AUDIO_CREDITS.creator)}</b></span><i aria-hidden="true">↗</i></a>
        <footer>${creditLicense(AUDIO_CREDITS.license, AUDIO_CREDITS.licenseUrl)}</footer>
      </article>
      <article class="credit-card credit-card--movement">
        <header><span>◆</span><small>MOVIMIENTO DE FICHAS</small></header>
        <h2>${escapeHtml(movement.title)}</h2>
        <p>El golpe de madera que se escucha al completar una jugada.</p>
        <a class="credit-author" href="${escapeHtml(movement.sourceUrl)}" target="_blank" rel="noreferrer"><span><small>AUTOR</small><b>${escapeHtml(movement.creator)}</b></span><i aria-hidden="true">↗</i></a>
        <footer>${movement.licenses.map((license) => creditLicense(license.label, license.url)).join("")}</footer>
      </article>
      <article class="credit-card credit-card--capture">
        <header><span>×</span><small>CAPTURA DE FICHAS</small></header>
        <h2>${escapeHtml(capture.title)}</h2>
        <p>El clic que marca cada ficha capturada, incluso en secuencias múltiples.</p>
        <a class="credit-author" href="${escapeHtml(capture.sourceUrl)}" target="_blank" rel="noreferrer"><span><small>AUTOR</small><b>${escapeHtml(capture.creator)}</b></span><i aria-hidden="true">↗</i></a>
        <footer>${creditLicense(capture.license, capture.licenseUrl)}</footer>
      </article>
      <article class="credit-card credit-card--trophies">
        <header><span>♛</span><small>TROFEOS DEL CAMPEONATO MUNDIAL</small></header>
        <h2>${escapeHtml(WORLD_TROPHY_CREDIT.title)}</h2>
        <p>Trofeos oficiales de oro, plata y bronce entregados a los tres campeones mundiales vigentes.</p>
        <div class="credit-trophy-preview" aria-label="Trofeos del Campeonato Mundial">
          ${WORLD_TROPHY_CREDIT.sources.map((source) => {
            const trophy = WORLD_TROPHY_DETAILS[source.placement];
            return `<span><img src="${trophy.image}" width="32" height="32" alt="Trofeo de ${escapeHtml(source.label.toLowerCase())}" /><small>${escapeHtml(source.label)}</small></span>`;
          }).join("")}
        </div>
        <a class="credit-author" href="${escapeHtml(WORLD_TROPHY_CREDIT.creatorUrl)}" target="_blank" rel="noreferrer"><span><small>FUENTE</small><b>${escapeHtml(WORLD_TROPHY_CREDIT.creator)}</b></span><i aria-hidden="true">↗</i></a>
        <footer>${WORLD_TROPHY_CREDIT.sources.map((source) => creditLicense(source.label, source.url)).join("")}</footer>
      </article>
    </section>
    <section class="credits-thanks"><span>${brandMarkMarkup()}</span><div><small>GRACIAS POR COMPARTIR SU TRABAJO</small><h2>Su creatividad también forma parte de cada partida.</h2><p>Los enlaces de autor, las fuentes y las licencias permanecen disponibles en esta página.</p></div></section>
  `, "credits");
  bindNavigation();
}

function isLegalPath(path: string): path is LegalPath {
  return LEGAL_ROUTES.some((item) => item.path === path);
}

function renderInformationHub() {
  const descriptions: Record<LegalPath, string> = {
    "/acerca-de": "Conoce el propósito y los principios de King Damas.",
    "/contacto": "Encuentra ayuda para tu cuenta, privacidad o convivencia.",
    "/politica-de-cookies": "Consulta qué se guarda en tu navegador y para qué se utiliza.",
    "/terminos-y-condiciones": "Revisa las reglas de uso, juego limpio y participación.",
    "/politica-de-privacidad": "Descubre cómo usamos y protegemos tus datos personales.",
  };
  root.innerHTML = appLayout(`
    <section class="page-heading information-heading">
      <div><span class="eyebrow"><i></i>CENTRO DE INFORMACIÓN</span><h1>Información</h1><p>Todo lo que necesitas saber sobre King Damas, tu cuenta y las reglas de la plataforma.</p></div>
      <span class="information-seal" aria-hidden="true">i</span>
    </section>
    <section class="information-grid" aria-label="Opciones de información">
      ${LEGAL_ROUTES.map((item, index) => `<button class="panel information-card" type="button" data-route="${item.path}"><span>${String(index + 1).padStart(2, "0")}</span><div><small>INFORMACIÓN</small><h2>${item.label}</h2><p>${descriptions[item.path]}</p></div><i aria-hidden="true">→</i></button>`).join("")}
    </section>
    <aside class="information-help"><span>${icon("send")}</span><p><b>¿No encontraste lo que buscabas?</b><small>Puedes escribirnos directamente desde la sección Contacto.</small></p><button class="text-button" type="button" data-route="/contacto">Ir a Contacto →</button></aside>
  `, "legal");
  bindNavigation();
}

function howToPlayMarkup() {
  return `<section class="page-heading legal-heading"><div><span class="eyebrow"><i></i>GUÍA DEL TABLERO 10×10</span><h1>Cómo jugar damas internacionales</h1><p>Aprende la posición inicial, los movimientos, las capturas obligatorias y la coronación antes de entrar a tu primera mesa.</p></div><span class="mode-pill mode-pill--large">10 × 10</span></section>
    <article class="panel how-to-document">
      <section class="how-to-intro"><div><span class="section-kicker">OBJETIVO</span><h2>Captura o bloquea todas las fichas rivales</h2><p>Ganas cuando tu rival se queda sin fichas o no dispone de ningún movimiento legal. Cada decisión ocurre sobre las 50 casillas oscuras de un tablero de 100 cuadros.</p></div><div class="how-to-board-facts"><span><b>10×10</b><small>tablero</small></span><span><b>20</b><small>fichas por lado</small></span><span><b>2</b><small>filas centrales libres</small></span></div></section>
      <section><span class="how-to-step">01</span><div><h2>Posición inicial</h2><p>Cada jugador comienza con veinte fichas colocadas sobre las casillas oscuras de sus primeras cuatro filas. Las filas quinta y sexta permanecen vacías para abrir el centro del tablero.</p></div></section>
      <section><span class="how-to-step">02</span><div><h2>Movimiento de una ficha</h2><p>Una ficha normal avanza una casilla en diagonal hacia una casilla oscura libre. Durante una captura puede saltar piezas rivales tanto hacia delante como hacia atrás.</p></div></section>
      <section><span class="how-to-step">03</span><div><h2>La captura es obligatoria</h2><p>Si existe una captura, debes realizarla. Cuando hay varias alternativas se elige la secuencia que captura más fichas; si dos secuencias capturan la misma cantidad, tiene prioridad la que captura más damas. Una misma jugada puede encadenar varios saltos.</p></div></section>
      <section><span class="how-to-step">04</span><div><h2>Coronación y dama voladora</h2><p>Cuando una ficha alcanza la última fila se convierte en dama. La dama puede desplazarse varias casillas libres por una diagonal y capturar a distancia, aterrizando en una casilla libre situada después de la pieza rival.</p></div></section>
      <section><span class="how-to-step">05</span><div><h2>Reloj y final de partida</h2><p>King Damas ofrece controles de 10, 30 y 60 minutos por jugador. También puedes ganar por tiempo o por rendición; las tablas pueden acordarse durante una partida disponible.</p></div></section>
      <section class="how-to-modes"><div><span class="section-kicker">PRACTICA A TU MANERA</span><h2>Tres formas de entrar al tablero</h2></div><div><article><b>Camino de Leyendas</b><p>Entrena contra rivales virtuales de dificultad progresiva sin afectar tu Elo.</p></article><article><b>Desafiar a un amigo</b><p>Crea un enlace privado y compártelo con la persona que quieras enfrentar.</p></article><article><b>Buscar rival</b><p>Entra al emparejamiento clasificado y compite con jugadores de nivel similar.</p></article></div></section>
      <footer class="how-to-cta"><div><span class="section-kicker">LA MESA ESTÁ LISTA</span><h2>Aprende jugando una partida gratuita</h2></div><button class="button button--primary" type="button" data-open-auth="register">Crear cuenta y jugar</button></footer>
    </article>`;
}

function renderHowToPlay() {
  const content = howToPlayMarkup();
  root.innerHTML = currentUser
    ? appLayout(content, "game")
    : publicPageLayout(content);
  bindNavigation();
  if (!currentUser) bindAuthDialog();
}

function termsConsentMarkup() {
  if (!currentUser) return "";
  const acceptedAt = legalConsentAcceptedAt();
  if (acceptedAt) {
    const date = new Date(acceptedAt).toLocaleString(localeCode(), {
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    return `<section class="legal-acceptance-card is-accepted" data-legal-consent-status><i>✓</i><span><b>Términos aceptados</b><small>Confirmados el ${escapeHtml(date)} para esta cuenta.</small></span></section>`;
  }
  return `<section class="legal-acceptance-card" data-legal-consent-status><i>!</i><span><b>Tu aceptación está pendiente</b><small>Lee el documento y confirma tu decisión.</small></span><button class="button button--primary" type="button" data-accept-terms>Aceptar términos</button></section>`;
}

function legalAboutMarkup() {
  return `<div class="legal-lead"><span>${brandMarkMarkup()}</span><div><small>NUESTRA RAZÓN DE JUGAR</small><h2>Damas internacionales para una comunidad que piensa en grande.</h2><p>King Damas es una plataforma dedicada exclusivamente al tablero 10×10, creada para reunir competencia, aprendizaje y comunidad en una experiencia clara y accesible.</p></div></div>
    <section><h2>Qué encontrarás aquí</h2><div class="legal-feature-grid"><span><b>Competición justa</b><small>Partidas clasificadas con Elo Damas y relojes de 10, 30 o 60 minutos.</small></span><span><b>Aprendizaje</b><small>Un Camino de Leyendas con dificultad progresiva para entrenar sin afectar tu Elo.</small></span><span><b>Comunidad</b><small>Amigos, mensajes, torneos y partidas en vivo para compartir la afición.</small></span></div></section>
    <section><h2>Nuestros principios</h2><p>Buscamos una mesa respetuosa, reglas transparentes, resultados trazables y mejoras continuas. El juego limpio y el trato digno entre jugadores están por encima de cualquier clasificación.</p></section>`;
}

function legalContactMarkup() {
  return `<div class="legal-contact-card"><span>${icon("send")}</span><div><small>CANAL PRINCIPAL</small><h2>admin@kingdamas.com</h2><p>Escríbenos desde tu correo e incluye tu nombre de usuario si la consulta se relaciona con tu cuenta.</p></div><a class="button button--primary" href="mailto:admin@kingdamas.com?subject=Contacto%20King%20Damas">Escribir correo</a></div>
    <section><h2>¿En qué podemos ayudarte?</h2><div class="legal-feature-grid"><span><b>Cuenta y soporte</b><small>Acceso, perfil, partidas o errores técnicos.</small></span><span><b>Privacidad</b><small>Acceso, corrección o eliminación de tus datos personales.</small></span><span><b>Convivencia</b><small>Reportes de conducta, suplantación o uso indebido de la plataforma.</small></span></div></section>
    <section><h2>Para responder mejor</h2><p>No envíes contraseñas, datos bancarios ni códigos de acceso. Describe lo ocurrido, indica la fecha aproximada y, si corresponde, el número de partida o torneo. Procuraremos responder tan pronto como sea razonablemente posible.</p></section>
    <aside class="legal-note"><b>Seguridad de pagos</b><p>Las donaciones y pagos habilitados se procesan mediante proveedores externos. King Damas nunca te pedirá por correo la contraseña de tu cuenta ni los datos completos de una tarjeta.</p></aside>`;
}

function legalCookiesMarkup() {
  return `<aside class="legal-note legal-note--green"><b>Uso actual</b><p>El sitio web de King Damas no utiliza cookies publicitarias ni de seguimiento. Solo emplea los recursos esenciales para mantener la sesión y preferencias locales para personalizar el juego. La aplicación iOS puede utilizar identificadores publicitarios conforme a las opciones de privacidad del usuario.</p></aside>
    <section><h2>Cookies y almacenamiento utilizados</h2><div class="legal-data-table"><div><b>king_damas_session</b><span>Cookie esencial</span><p>Mantiene la sesión iniciada y protege el acceso a la cuenta. Se gestiona de forma segura.</p></div><div><b>Preferencia de idioma</b><span>Cuenta y almacenamiento local</span><p>Recuerda si prefieres Español o English en tu cuenta y en este navegador.</p></div><div><b>Preferencias de sonido</b><span>Almacenamiento local</span><p>Recuerda música, efectos y volumen elegidos en este navegador.</p></div><div><b>Consentimiento legal</b><span>Almacenamiento local</span><p>Evita pedir nuevamente la misma aceptación a la misma cuenta en este navegador.</p></div></div></section>
    <section><h2>Servicios externos</h2><p>PayPal solo interviene cuando visitas la sección de donaciones y puede gestionar datos conforme a sus propias políticas. En la aplicación para iOS, Google Mobile Ads puede almacenar o acceder a identificadores y preferencias necesarios para servir, medir y limitar anuncios, según tu elección de privacidad y la normativa aplicable.</p></section>
    <section><h2>Cómo controlarlas</h2><p>Puedes borrar cookies y datos locales desde la configuración del navegador. Si eliminas la cookie de sesión, tendrás que iniciar sesión nuevamente; si eliminas las preferencias, se restaurarán sus valores predeterminados.</p></section>
    <section><h2>Cambios</h2><p>Si en el futuro se incorporan cookies analíticas, publicitarias o cualquier uso no esencial, esta política se actualizará y se solicitará la elección correspondiente antes de activarlas.</p></section>`;
}

function legalTermsMarkup() {
  return `${termsConsentMarkup()}
    <section><h2>1. Aceptación y cuenta</h2><p>Al crear o utilizar una cuenta confirmas que puedes aceptar estas condiciones. Si eres menor de edad, debes contar con autorización y supervisión de tu padre, madre o tutor legal. Debes proporcionar información válida, proteger tus credenciales y responder por la actividad de tu cuenta.</p></section>
    <section><h2>2. Uso permitido</h2><p>King Damas está destinado al juego de damas internacionales 10×10, la interacción comunitaria y la participación en actividades anunciadas. No puedes automatizar partidas, manipular resultados o Elo, explotar fallos, suplantar a otra persona, acosar, amenazar ni publicar contenido ilícito.</p></section>
    <section><h2>3. Juego limpio y moderación</h2><p>Podemos investigar conductas irregulares y aplicar advertencias, anular resultados, limitar funciones o suspender cuentas cuando sea necesario para proteger a la comunidad. Las decisiones competitivas podrán revisarse cuando exista evidencia suficiente.</p></section>
    <section><h2>4. Elo Damas, torneos y pagos</h2><p>El Elo Damas es una medida interna de rendimiento y no tiene valor monetario. Cada torneo puede tener bases adicionales, fechas, requisitos y premios publicados en su ficha. Las donaciones son voluntarias y no conceden ventajas competitivas. En iOS, la suscripción Premium es anual, se cobra a tu Apple ID y elimina anuncios al usar la misma cuenta King Damas en iOS, Android y web. Se renueva automáticamente salvo que la canceles al menos 24 horas antes de finalizar el periodo vigente. Puedes administrarla o cancelarla desde la configuración de suscripciones de App Store. Los precios y condiciones definitivos son los que App Store muestra antes de confirmar la compra.</p></section>
    <section><h2>5. Disponibilidad y cambios</h2><p>Trabajamos para ofrecer un servicio estable, pero no garantizamos funcionamiento ininterrumpido. Podemos realizar mantenimiento, corregir resultados afectados por errores técnicos y actualizar funciones o estas condiciones. Los cambios importantes serán comunicados dentro de la plataforma y podrán requerir una nueva aceptación.</p></section>
    <section><h2>6. Responsabilidad</h2><p>La plataforma se ofrece según su disponibilidad. En la medida permitida por la ley aplicable, King Damas no responde por interrupciones ajenas a su control, pérdidas indirectas ni decisiones tomadas con base en una clasificación provisional.</p></section>
    <section><h2>7. Legislación y contacto</h2><p>Estas condiciones se interpretan conforme a las leyes aplicables de la República Dominicana. Para preguntas o reclamaciones, escribe a <a href="mailto:admin@kingdamas.com">admin@kingdamas.com</a>. Puedes consultar como referencia la <a href="https://dgii.gov.do/legislacion/leyesTributarias/Documents/Otras%20Leyes%20de%20Inter%C3%A9s/126-02.pdf" target="_blank" rel="noreferrer">Ley 126-02 sobre comercio electrónico y documentos digitales ↗</a>.</p></section>`;
}

function legalPrivacyMarkup() {
  return `<aside class="legal-note legal-note--green"><b>Compromiso de privacidad</b><p>Usamos los datos necesarios para operar la cuenta, las partidas y la comunidad. No vendemos información personal.</p></aside>
    <section><h2>1. Datos que tratamos</h2><p>Podemos tratar nombre, usuario, correo, país, preferencia de idioma, foto de perfil, contraseña protegida mediante hash, historial de acceso, partidas, Elo Damas, amistades, mensajes, inscripciones a torneos, referencias de transacciones y datos técnicos necesarios para seguridad y diagnóstico. En iOS, Google Mobile Ads también puede tratar identificadores del dispositivo, dirección IP, interacciones con anuncios e información de diagnóstico según tu configuración de consentimiento y las opciones permitidas por Apple.</p></section>
    <section><h2>2. Para qué los utilizamos</h2><p>Los usamos para autenticarte, operar partidas en tiempo real, calcular clasificaciones, mostrar tu perfil, facilitar funciones comunitarias, gestionar torneos y pagos, atender solicitudes, prevenir abuso y mantener la seguridad y estabilidad del servicio.</p></section>
    <section><h2>3. Información visible</h2><p>Tu nombre, usuario, país, foto, rango, Elo Damas y actividad competitiva pueden mostrarse a otros usuarios. El correo, la contraseña y los datos privados de soporte no se publican. Los mensajes se muestran únicamente a sus participantes, salvo revisión necesaria por seguridad o cumplimiento.</p></section>
    <section><h2>4. Proveedores y transferencias</h2><p>Podemos utilizar proveedores especializados para prestar funciones esenciales, enviar correos, procesar compras mediante Apple y mostrar anuncios mediante Google Mobile Ads. Algunos pueden procesar información fuera de la República Dominicana conforme a sus propias políticas y mecanismos legales. Solo se comparte lo necesario para su función o cuando exista una obligación legal válida. Cuando corresponda, puedes revisar o cambiar las opciones de privacidad publicitaria desde la sección Apoyar de la aplicación iOS.</p></section>
    <section><h2>5. Conservación y seguridad</h2><p>Conservamos la información mientras la cuenta esté activa y durante el tiempo adicional razonablemente necesario para seguridad, resolución de disputas y obligaciones legales. Aplicamos controles técnicos y organizativos, aunque ningún sistema conectado a internet puede garantizar riesgo cero.</p></section>
    <section><h2>6. Tus derechos</h2><p>Puedes solicitar acceso, corrección, actualización o eliminación de tus datos, sujeto a las excepciones legales y registros que debamos conservar. Envía la solicitud desde el correo asociado a tu cuenta a <a href="mailto:admin@kingdamas.com?subject=Solicitud%20de%20privacidad%20King%20Damas">admin@kingdamas.com</a>.</p></section>
    <section><h2>7. Marco y actualizaciones</h2><p>Esta política toma como referencia la protección de datos aplicable en la República Dominicana, incluida la <a href="https://presidencia.gob.do/sites/default/files/statics/transparencia/marco-legal/leyes/Ley-172-13.pdf" target="_blank" rel="noreferrer">Ley 172-13 sobre Protección de Datos Personales ↗</a>. Informaremos cambios relevantes y solicitaremos una nueva confirmación cuando corresponda.</p></section>`;
}

function legalPageMarkup(path: LegalPath) {
  const pages: Record<LegalPath, { title: string; eyebrow: string; description: string; body: () => string }> = {
    "/acerca-de": { title: "Acerca de", eyebrow: "CONOCE KING DAMAS", description: "El propósito y los principios detrás de cada mesa.", body: legalAboutMarkup },
    "/contacto": { title: "Contacto", eyebrow: "ESTAMOS PARA AYUDAR", description: "Un canal claro para soporte, privacidad y asuntos de la comunidad.", body: legalContactMarkup },
    "/politica-de-cookies": { title: "Política de cookies", eyebrow: "CONTROL Y TRANSPARENCIA", description: "Qué guarda King Damas en tu navegador y para qué se utiliza.", body: legalCookiesMarkup },
    "/terminos-y-condiciones": { title: "Términos y condiciones", eyebrow: "REGLAS DE LA PLATAFORMA", description: "Las condiciones para usar King Damas y compartir una mesa justa.", body: legalTermsMarkup },
    "/politica-de-privacidad": { title: "Política de privacidad", eyebrow: "TUS DATOS, CON CLARIDAD", description: "Cómo recopilamos, utilizamos y protegemos tu información.", body: legalPrivacyMarkup },
  };
  const page = pages[path];
  const menu = LEGAL_ROUTES.map((item, index) => {
    const content = `<i>${String(index + 1).padStart(2, "0")}</i><span>${item.shortLabel}</span><b aria-hidden="true">›</b>`;
    return currentUser
      ? `<button class="${item.path === path ? "is-active" : ""}" type="button" data-route="${item.path}">${content}</button>`
      : `<a class="${item.path === path ? "is-active" : ""}" href="${item.path}">${content}</a>`;
  }).join("");
  return `<section class="page-heading legal-heading"><div><span class="eyebrow"><i></i>${page.eyebrow}</span><h1>${page.title}</h1><p>${page.description}</p></div><span class="legal-updated"><small>ÚLTIMA ACTUALIZACIÓN</small><b>9 ago 2026</b></span></section>
    <div class="legal-layout">
      <aside class="panel legal-page-menu"><small>INFORMACIÓN</small>${menu}</aside>
      <article class="panel legal-document">${page.body()}<footer><span>${brandMarkMarkup()}</span><p><b>King Damas</b><small>Damas internacionales 10×10 · República Dominicana</small></p></footer></article>
    </div>`;
}

function renderLegalPage(path: LegalPath) {
  const content = legalPageMarkup(path);
  root.innerHTML = currentUser
    ? appLayout(content, "legal")
    : publicPageLayout(content);
  bindNavigation();
  if (!currentUser) bindAuthDialog();
}

function communityPlayerMarkup(
  player: User & { rating?: number },
  isFriend: boolean,
  placement: "friends" | "discover",
) {
  return `<article class="community-player">
    ${playerProfileButton(player, `${avatarMarkup(player, "avatar avatar--community")}<span class="community-player-copy"><span class="player-name-with-title"><b>${escapeHtml(player.name)}</b>${worldTrophyMarkup(player)}</span><small>${flag(player.countryCode)} @${escapeHtml(player.username)}</small>${worldTitleRecognitionMarkup(player, "world-title-recognition--compact")}</span>`, "community-player-profile")}
    ${player.rating !== undefined ? `<strong>${player.rating.toLocaleString(localeCode())}<small>Elo</small></strong>` : ""}
    <div class="community-player-actions">
      <button type="button" data-open-conversation="${escapeHtml(player.username)}" aria-label="Enviar mensaje a ${escapeHtml(player.name)}" title="Mensaje">${icon("chat")}</button>
      ${placement === "friends"
        ? `<button class="is-danger" type="button" data-remove-friend="${escapeHtml(player.username)}" aria-label="Eliminar a ${escapeHtml(player.name)} de tus amigos" title="Eliminar de amigos">×</button>`
        : `<button class="add-player ${isFriend ? "is-added" : ""}" type="button" ${isFriend ? "disabled" : `data-add-friend="${escapeHtml(player.username)}"`} aria-label="${isFriend ? "Ya está en tus amigos" : `Agregar a ${escapeHtml(player.name)}`}" title="${isFriend ? "Ya agregado" : "Agregar amigo"}">${isFriend ? "✓" : icon("userPlus")}</button>`}
    </div>
  </article>`;
}

function communityConversationMarkup(conversation: DirectConversation) {
  const when = new Date(conversation.lastMessageAt).toLocaleDateString(localeCode(), {
    day: "2-digit",
    month: "short",
  });
  return `<article class="conversation-row">
    ${playerProfileButton(conversation.user, `${avatarMarkup(conversation.user, "avatar avatar--community")}<span><span class="player-name-with-title"><b>${escapeHtml(conversation.user.name)}</b>${worldTrophyMarkup(conversation.user)}</span><small>@${escapeHtml(conversation.user.username)}</small>${worldTitleRecognitionMarkup(conversation.user, "world-title-recognition--compact")}</span>`, "conversation-player-profile")}
    <time>${escapeHtml(when)}</time>
    <button class="conversation-preview" type="button" data-open-conversation="${escapeHtml(conversation.user.username)}" aria-label="Abrir conversación con ${escapeHtml(conversation.user.name)}"><span>${icon("chat")}</span>${conversation.lastMessageOwn ? "Tú: " : ""}<span class="conversation-preview-message" translate="no">${escapeHtml(conversation.lastMessage)}</span></button>
    ${conversation.unreadCount ? `<i>${conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}</i>` : ""}
  </article>`;
}

function communityListMoreMarkup(
  kind: "friends" | "discovery" | "conversations" | "tournament-participants" | "live-games" | "game-messages",
  hasMore: boolean,
) {
  return hasMore
    ? `<div class="profile-following-more"><button class="button button--quiet button--small" type="button" data-load-more-${kind}>Ver ${LIST_PAGE_SIZE} más</button></div>`
    : "";
}

function communityMarkup(
  friends: User[],
  discovery: LeaderboardPlayer[],
  conversations: DirectConversation[],
  totalPlayers: number,
  registeredUsers: number,
  pagination: {
    friendsTotal: number;
    friendsHasMore: boolean;
    discoveryHasMore: boolean;
    conversationsHasMore: boolean;
    unreadCount: number;
  },
) {
  const friendNames = new Set(friends.map((friend) => friend.username));
  const visibleDiscovery = discovery.filter((player) => player.id !== currentUser?.id);
  return `
    <section class="page-heading community-heading">
      <div><span class="eyebrow"><i></i>JUGADORES DE KING DAMAS</span><h1>Comunidad</h1><span class="community-registered-count" aria-label="${registeredUsers.toLocaleString(localeCode())} usuarios registrados"><b>${registeredUsers.toLocaleString(localeCode())}</b></span><p>Encuentra rivales, crea tu círculo y mantén la conversación fuera del tablero.</p></div>
      <div class="community-stats"><span><b>${totalPlayers.toLocaleString(localeCode())}</b><small>Clasificados</small></span><span><b data-community-friend-count>${pagination.friendsTotal}</b><small>Amigos</small></span><span><b data-community-unread-count>${pagination.unreadCount}</b><small>Sin leer</small></span></div>
    </section>
    <label class="community-search"><span>${icon("search")}</span><input type="search" autocomplete="off" minlength="2" maxlength="60" placeholder="Buscar por nombre o @usuario…" data-community-search /><kbd>Buscar</kbd></label>
    <div class="community-grid">
      <section class="panel community-panel community-friends">
        <div class="community-panel-heading"><span><small>TU CÍRCULO</small><h2>Amigos</h2></span><b data-community-friend-count>${pagination.friendsTotal}</b></div>
        <div class="community-player-list" data-friends-list>
          ${friends.length ? friends.map((player) => communityPlayerMarkup(player, true, "friends")).join("") : `<div class="community-empty"><span>${icon("users")}</span><b>Tu círculo comienza aquí</b><p>Busca jugadores y agrégalos para encontrarlos rápidamente.</p></div>`}
          ${communityListMoreMarkup("friends", pagination.friendsHasMore)}
        </div>
      </section>
      <section class="panel community-panel community-discover">
        <div class="community-panel-heading"><span><small data-discovery-kicker>CLASIFICACIÓN MUNDIAL</small><h2 data-discovery-title>Descubrir jugadores</h2></span><span class="community-live"><i></i>Activa</span></div>
        <div class="community-player-list" data-discovery-list>
          ${visibleDiscovery.length ? visibleDiscovery.map((player) => communityPlayerMarkup(player, friendNames.has(player.username), "discover")).join("") : `<div class="community-empty"><span>${icon("search")}</span><b>No hay jugadores para mostrar</b><p>Usa la búsqueda para encontrar a alguien.</p></div>`}
          ${communityListMoreMarkup("discovery", pagination.discoveryHasMore)}
        </div>
      </section>
      <section class="panel community-panel community-conversations">
        <div class="community-panel-heading"><span><small>MENSAJES PRIVADOS</small><h2>Conversaciones</h2></span><b data-conversation-unread-label ${pagination.unreadCount ? "" : "hidden"}>${pagination.unreadCount} nuevos</b></div>
        <div class="conversation-list" data-conversation-list>
          ${conversations.length ? conversations.map(communityConversationMarkup).join("") : `<div class="community-empty community-empty--compact"><span>${icon("chat")}</span><b>Aún no hay mensajes</b><p>Abre una conversación desde cualquier jugador.</p></div>`}
          ${communityListMoreMarkup("conversations", pagination.conversationsHasMore)}
        </div>
      </section>
    </div>
    <dialog class="direct-chat-dialog" aria-labelledby="direct-chat-name">
      <header><div data-direct-chat-user></div><button type="button" data-close-direct-chat aria-label="Cerrar conversación">×</button></header>
      <div class="direct-chat-messages" data-direct-chat-messages><span class="loader loader--small"></span></div>
      <form class="direct-chat-form" data-direct-chat-form><input name="message" maxlength="500" autocomplete="off" placeholder="Escribe un mensaje…" aria-label="Mensaje" required /><button type="submit" aria-label="Enviar">${icon("send")}</button></form>
      <p class="direct-chat-error" data-direct-chat-error aria-live="polite"></p>
    </dialog>`;
}

async function renderCommunity() {
  pageCleanup?.();
  pageCleanup = null;
  root.innerHTML = appLayout(loadingMarkup("Reuniendo a la comunidad…"), "community");
  bindNavigation();
  try {
    const [friendsResponse, leaderboardResponse, conversationsResponse, statsResponse] = await Promise.all([
      api.following(currentUser!.username),
      api.leaderboard("WORLD"),
      api.conversations(),
      api.communityStats(),
    ]);
    root.innerHTML = appLayout(
      communityMarkup(
        friendsResponse.users,
        leaderboardResponse.players,
        conversationsResponse.conversations,
        leaderboardResponse.totalPlayers,
        statsResponse.registeredUsers,
        {
          friendsTotal: friendsResponse.total,
          friendsHasMore: friendsResponse.hasMore,
          discoveryHasMore: leaderboardResponse.hasMore,
          conversationsHasMore: conversationsResponse.hasMore,
          unreadCount: conversationsResponse.unreadCount,
        },
      ),
      "community",
    );
    bindNavigation();
    bindCommunity(
      friendsResponse,
      leaderboardResponse,
      conversationsResponse,
    );
  } catch (error) {
    root.innerHTML = appLayout(errorState(errorMessage(error)), "community");
    bindNavigation();
    bindRetry(() => renderCommunity());
  }
}

function bindCommunity(
  initialFriends: Awaited<ReturnType<typeof api.following>>,
  initialDiscovery: Awaited<ReturnType<typeof api.leaderboard>>,
  initialConversations: Awaited<ReturnType<typeof api.conversations>>,
) {
  const search = root.querySelector<HTMLInputElement>("[data-community-search]");
  const friendsList = root.querySelector<HTMLElement>("[data-friends-list]");
  const discoveryList = root.querySelector<HTMLElement>("[data-discovery-list]");
  const discoveryTitle = root.querySelector<HTMLElement>("[data-discovery-title]");
  const discoveryKicker = root.querySelector<HTMLElement>("[data-discovery-kicker]");
  const conversationList = root.querySelector<HTMLElement>("[data-conversation-list]");
  const dialog = root.querySelector<HTMLDialogElement>(".direct-chat-dialog");
  const directUser = dialog?.querySelector<HTMLElement>("[data-direct-chat-user]");
  const directMessages = dialog?.querySelector<HTMLElement>("[data-direct-chat-messages]");
  const directForm = dialog?.querySelector<HTMLFormElement>("[data-direct-chat-form]");
  const directError = dialog?.querySelector<HTMLElement>("[data-direct-chat-error]");
  const friendNames = new Set(initialFriends.users.map((friend) => friend.username));
  const knownPlayers = new Map<string, User>(
    [...initialFriends.users, ...initialDiscovery.players].map((player) => [player.username, player]),
  );
  let friendList = [...initialFriends.users];
  let friendTotal = initialFriends.total;
  let friendsOffset = initialFriends.nextOffset;
  let friendsHaveMore = initialFriends.hasMore;
  const discoveryPlayers: Array<User & { rating?: number }> = [...initialDiscovery.players];
  let discoveryOffset = initialDiscovery.nextOffset;
  let discoveryHasMore = initialDiscovery.hasMore;
  let visibleDiscovery: Array<User & { rating?: number }> = [...discoveryPlayers];
  let activeSearchQuery = "";
  let discoverySearchOffset = 0;
  let discoverySearchHasMore = false;
  let conversationItems = [...initialConversations.conversations];
  let conversationOffset = initialConversations.nextOffset;
  let conversationsHaveMore = initialConversations.hasMore;
  let conversationUnreadCount = initialConversations.unreadCount;
  let discoverySearching = false;
  let searchTimer = 0;
  let searchSequence = 0;
  let activeUsername = "";
  let activeMessages: DirectMessage[] = [];
  let activeMessageOffset = 0;
  let activeMessagesHaveMore = false;
  let olderMessagesLoading = false;
  let conversationLoading = false;
  let conversationListLoading = false;

  const updateFriendCounts = () => {
    root.querySelectorAll<HTMLElement>("[data-community-friend-count]").forEach((element) => {
      element.textContent = String(friendTotal);
    });
  };

  const bindPlayerActions = (scope: ParentNode = root) => {
    scope.querySelectorAll<HTMLButtonElement>("[data-add-friend]").forEach((button) => {
      button.addEventListener("click", async () => {
        const username = button.dataset.addFriend || "";
        button.disabled = true;
        try {
          await api.follow(username);
          friendNames.add(username);
          const player = knownPlayers.get(username);
          if (player && !friendList.some((friend) => friend.username === username)) {
            friendList.push(player);
            friendTotal += 1;
          }
          renderFriends();
          renderDiscovery(visibleDiscovery, discoverySearching);
          toast(`@${username} fue agregado a tus amigos.`);
        } catch (error) {
          button.disabled = false;
          toast(errorMessage(error), "error");
        }
      });
    });
    scope.querySelectorAll<HTMLButtonElement>("[data-remove-friend]").forEach((button) => {
      button.addEventListener("click", async () => {
        const username = button.dataset.removeFriend || "";
        button.disabled = true;
        try {
          await api.unfollow(username);
          const wasFriend = friendNames.delete(username);
          friendList = friendList.filter((friend) => friend.username !== username);
          if (wasFriend) {
            friendTotal = Math.max(0, friendTotal - 1);
            friendsOffset = Math.max(0, friendsOffset - 1);
          }
          renderFriends();
          renderDiscovery(visibleDiscovery, discoverySearching);
          toast(`@${username} fue eliminado de tus amigos.`);
        } catch (error) {
          button.disabled = false;
          toast(errorMessage(error), "error");
        }
      });
    });
    scope.querySelectorAll<HTMLButtonElement>("[data-open-conversation]").forEach((button) => {
      button.addEventListener("click", () => void openConversation(button.dataset.openConversation || ""));
    });
  };

  const renderFriends = () => {
    if (!friendsList) return;
    friendsList.innerHTML = friendList.length
      ? `${friendList.map((player) => communityPlayerMarkup(player, true, "friends")).join("")}${communityListMoreMarkup("friends", friendsHaveMore)}`
      : `<div class="community-empty"><span>${icon("users")}</span><b>Tu círculo comienza aquí</b><p>Busca jugadores y agrégalos para encontrarlos rápidamente.</p></div>`;
    updateFriendCounts();
    bindPlayerActions(friendsList);
    bindCommunityLoaders();
  };

  const renderDiscovery = (players: Array<User & { rating?: number }>, searching: boolean) => {
    if (!discoveryList) return;
    visibleDiscovery = players;
    discoverySearching = searching;
    players.forEach((player) => knownPlayers.set(player.username, player));
    const visible = players.filter((player) => player.id !== currentUser?.id);
    discoveryList.innerHTML = visible.length
      ? `${visible.map((player) => communityPlayerMarkup(player, friendNames.has(player.username), "discover")).join("")}${communityListMoreMarkup("discovery", searching ? discoverySearchHasMore : discoveryHasMore)}`
      : `<div class="community-empty"><span>${icon("search")}</span><b>No encontramos jugadores</b><p>Prueba con otro nombre o usuario.</p></div>`;
    if (discoveryTitle) discoveryTitle.textContent = searching ? "Resultados" : "Descubrir jugadores";
    if (discoveryKicker) discoveryKicker.textContent = searching ? "BÚSQUEDA DE JUGADORES" : "CLASIFICACIÓN MUNDIAL";
    bindPlayerActions(discoveryList);
    bindCommunityLoaders();
  };

  const renderDirectMessages = (messages: DirectMessage[], scrollToBottom = true) => {
    if (!directMessages) return;
    directMessages.innerHTML = messages.length
      ? `${activeMessagesHaveMore ? `<div class="community-list-more"><button class="button button--quiet button--small" type="button" data-load-older-direct>Ver ${LIST_PAGE_SIZE} anteriores</button></div>` : ""}${messages.map((message) => `<article class="direct-message ${message.own ? "is-own" : ""}"><p>${escapeHtml(message.message)}</p><time>${new Date(message.createdAt).toLocaleTimeString(localeCode(), { hour: "2-digit", minute: "2-digit" })}</time></article>`).join("")}`
      : `<div class="direct-chat-empty"><span>${icon("chat")}</span><p>Inicia la conversación con un saludo.</p></div>`;
    directMessages.querySelector<HTMLButtonElement>("[data-load-older-direct]")
      ?.addEventListener("click", () => void loadOlderDirectMessages());
    if (scrollToBottom) directMessages.scrollTop = directMessages.scrollHeight;
  };

  async function loadOlderDirectMessages() {
    if (!activeUsername || !activeMessagesHaveMore || olderMessagesLoading || !directMessages) return;
    olderMessagesLoading = true;
    const button = directMessages.querySelector<HTMLButtonElement>("[data-load-older-direct]");
    if (button) {
      button.disabled = true;
      button.textContent = "Cargando…";
    }
    const previousHeight = directMessages.scrollHeight;
    try {
      const response = await api.directMessages(activeUsername, activeMessageOffset);
      if (response.user.username !== activeUsername) return;
      const knownIds = new Set(activeMessages.map((message) => message.id));
      activeMessages = [
        ...response.messages.filter((message) => !knownIds.has(message.id)),
        ...activeMessages,
      ];
      activeMessageOffset = response.nextOffset;
      activeMessagesHaveMore = response.hasMore;
      renderDirectMessages(activeMessages, false);
      directMessages.scrollTop = directMessages.scrollHeight - previousHeight;
    } catch (error) {
      if (button) {
        button.disabled = false;
        button.textContent = `Ver ${LIST_PAGE_SIZE} anteriores`;
      }
      if (directError) directError.textContent = errorMessage(error);
    } finally {
      olderMessagesLoading = false;
    }
  }

  const renderConversationList = (conversations: DirectConversation[]) => {
    if (!conversationList) return;
    conversationList.innerHTML = conversations.length
      ? `${conversations.map(communityConversationMarkup).join("")}${communityListMoreMarkup("conversations", conversationsHaveMore)}`
      : `<div class="community-empty community-empty--compact"><span>${icon("chat")}</span><b>Aún no hay mensajes</b><p>Abre una conversación desde cualquier jugador.</p></div>`;
    const unreadStat = root.querySelector<HTMLElement>("[data-community-unread-count]");
    const unreadLabel = root.querySelector<HTMLElement>("[data-conversation-unread-label]");
    if (unreadStat) unreadStat.textContent = String(conversationUnreadCount);
    if (unreadLabel) {
      unreadLabel.hidden = conversationUnreadCount === 0;
      unreadLabel.textContent = `${conversationUnreadCount} nuevos`;
    }
    bindPlayerActions(conversationList);
    bindCommunityLoaders();
  };

  const bindCommunityLoaders = () => {
    friendsList?.querySelector<HTMLButtonElement>("[data-load-more-friends]")
      ?.addEventListener("click", async (event) => {
        const button = event.currentTarget as HTMLButtonElement;
        button.disabled = true;
        button.textContent = "Cargando…";
        try {
          const page = await api.following(currentUser!.username, friendsOffset);
          page.users.forEach((player) => {
            friendNames.add(player.username);
            knownPlayers.set(player.username, player);
            if (!friendList.some((friend) => friend.id === player.id)) friendList.push(player);
          });
          friendTotal = page.total;
          friendsOffset = page.nextOffset;
          friendsHaveMore = page.hasMore;
          renderFriends();
          renderDiscovery(visibleDiscovery, discoverySearching);
        } catch (error) {
          button.disabled = false;
          button.textContent = `Ver ${LIST_PAGE_SIZE} más`;
          toast(errorMessage(error), "error");
        }
      });
    discoveryList?.querySelector<HTMLButtonElement>("[data-load-more-discovery]")
      ?.addEventListener("click", async (event) => {
        const button = event.currentTarget as HTMLButtonElement;
        button.disabled = true;
        button.textContent = "Cargando…";
        try {
          if (discoverySearching) {
            const page = await api.searchUsers(activeSearchQuery, discoverySearchOffset);
            const knownIds = new Set(visibleDiscovery.map((player) => player.id));
            const nextPlayers = [
              ...visibleDiscovery,
              ...page.users.filter((player) => !knownIds.has(player.id)),
            ];
            discoverySearchOffset = page.nextOffset;
            discoverySearchHasMore = page.hasMore;
            renderDiscovery(nextPlayers, true);
            return;
          }
          const page = await api.leaderboard("WORLD", discoveryOffset);
          page.players.forEach((player) => {
            knownPlayers.set(player.username, player);
            if (!discoveryPlayers.some((known) => known.id === player.id)) discoveryPlayers.push(player);
          });
          discoveryOffset = page.nextOffset;
          discoveryHasMore = page.hasMore;
          renderDiscovery(discoveryPlayers, false);
        } catch (error) {
          button.disabled = false;
          button.textContent = `Ver ${LIST_PAGE_SIZE} más`;
          toast(errorMessage(error), "error");
        }
      });
    conversationList?.querySelector<HTMLButtonElement>("[data-load-more-conversations]")
      ?.addEventListener("click", async (event) => {
        const button = event.currentTarget as HTMLButtonElement;
        button.disabled = true;
        button.textContent = "Cargando…";
        try {
          const page = await api.conversations(conversationOffset);
          page.conversations.forEach((conversation) => {
            if (!conversationItems.some((known) => known.user.id === conversation.user.id)) {
              conversationItems.push(conversation);
            }
          });
          conversationOffset = page.nextOffset;
          conversationsHaveMore = page.hasMore;
          conversationUnreadCount = page.unreadCount;
          renderConversationList(conversationItems);
        } catch (error) {
          button.disabled = false;
          button.textContent = `Ver ${LIST_PAGE_SIZE} más`;
          toast(errorMessage(error), "error");
        }
      });
  };

  const refreshConversationList = async () => {
    if (conversationListLoading) return;
    conversationListLoading = true;
    try {
      const response = await api.conversations();
      if (route() === "/comunidad") {
        conversationItems = response.conversations;
        conversationOffset = response.nextOffset;
        conversationsHaveMore = response.hasMore;
        conversationUnreadCount = response.unreadCount;
        renderConversationList(conversationItems);
      }
    } catch {
      // Un próximo mensaje o la siguiente visita vuelve a sincronizar la lista.
    } finally {
      conversationListLoading = false;
    }
  };

  const refreshConversation = async () => {
    if (!activeUsername || conversationLoading || !dialog?.open) return;
    conversationLoading = true;
    try {
      const response = await api.directMessages(activeUsername);
      if (!dialog.open || response.user.username !== activeUsername) return;
      if (directUser) directUser.innerHTML = playerProfileButton(response.user, `${avatarMarkup(response.user, "avatar avatar--community")}<span><span class="player-name-with-title"><b id="direct-chat-name">${escapeHtml(response.user.name)}</b>${worldTrophyMarkup(response.user)}</span><small>${flag(response.user.countryCode)} @${escapeHtml(response.user.username)}</small>${worldTitleRecognitionMarkup(response.user, "world-title-recognition--compact")}</span>`, "direct-chat-player-profile");
      activeMessages = response.messages;
      activeMessageOffset = response.nextOffset;
      activeMessagesHaveMore = response.hasMore;
      renderDirectMessages(activeMessages);
    } catch (error) {
      if (directError) directError.textContent = errorMessage(error);
    } finally {
      conversationLoading = false;
    }
  };

  const closeConversation = () => {
    activeUsername = "";
    activeMessages = [];
    activeMessageOffset = 0;
    activeMessagesHaveMore = false;
    dialog?.close();
  };

  const openConversation = async (username: string) => {
    if (!dialog || !username) return;
    activeUsername = username;
    activeMessages = [];
    activeMessageOffset = 0;
    activeMessagesHaveMore = false;
    if (directUser) directUser.innerHTML = `<span><b id="direct-chat-name">Cargando…</b><small>@${escapeHtml(username)}</small></span>`;
    if (directMessages) directMessages.innerHTML = `<span class="loader loader--small"></span>`;
    if (directError) directError.textContent = "";
    if (!dialog.open) dialog.showModal();
    await refreshConversation();
    void refreshConversationList();
  };

  const receiveDirectMessage = (message: DirectMessage & {
    sender?: { username?: string };
  }) => {
    const senderUsername = message.sender?.username || "";
    if (
      dialog?.open
      && senderUsername === activeUsername
      && !activeMessages.some((item) => item.id === message.id)
    ) {
      activeMessages.push({ ...message, own: false });
      if (activeMessagesHaveMore) activeMessageOffset += 1;
      renderDirectMessages(activeMessages);
      void refreshConversationList();
      return;
    }
    void refreshConversationList();
  };

  bindPlayerActions();
  bindCommunityLoaders();
  socket?.on("message:received", receiveDirectMessage);
  search?.addEventListener("input", () => {
    if (searchTimer) window.clearTimeout(searchTimer);
    const query = search.value.trim();
    const sequence = ++searchSequence;
    if (query.length < 2) {
      activeSearchQuery = "";
      discoverySearchOffset = 0;
      discoverySearchHasMore = false;
      renderDiscovery(discoveryPlayers, false);
      return;
    }
    if (discoveryList) discoveryList.innerHTML = `<div class="community-searching"><span class="loader loader--small"></span><p>Buscando jugadores…</p></div>`;
    searchTimer = window.setTimeout(async () => {
      try {
        const response = await api.searchUsers(query);
        if (sequence === searchSequence) {
          activeSearchQuery = query;
          discoverySearchOffset = response.nextOffset;
          discoverySearchHasMore = response.hasMore;
          renderDiscovery(response.users, true);
        }
      } catch (error) {
        if (sequence === searchSequence && discoveryList) discoveryList.innerHTML = `<div class="community-empty"><b>No pudimos buscar</b><p>${escapeHtml(errorMessage(error))}</p></div>`;
      }
    }, 320);
  });
  dialog?.querySelector("[data-close-direct-chat]")?.addEventListener("click", closeConversation);
  dialog?.addEventListener("cancel", () => {
    activeUsername = "";
    activeMessages = [];
    activeMessageOffset = 0;
    activeMessagesHaveMore = false;
  });
  directForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = directForm.elements.namedItem("message") as HTMLInputElement;
    const submit = directForm.querySelector<HTMLButtonElement>("[type=submit]");
    const message = input.value.trim();
    if (!message || !activeUsername) return;
    submit?.setAttribute("disabled", "");
    if (directError) directError.textContent = "";
    try {
      const response = await api.sendDirectMessage(activeUsername, message);
      activeMessages.push(response.message);
      if (activeMessagesHaveMore) activeMessageOffset += 1;
      renderDirectMessages(activeMessages);
      input.value = "";
      void refreshConversationList();
    } catch (error) {
      if (directError) directError.textContent = errorMessage(error);
    } finally {
      submit?.removeAttribute("disabled");
      input.focus();
    }
  });
  pageCleanup = () => {
    if (searchTimer) window.clearTimeout(searchTimer);
    socket?.off("message:received", receiveDirectMessage);
    if (dialog?.open) dialog.close();
  };
}

function tournamentDate(value: string | Date) {
  return new Date(value).toLocaleDateString(localeCode(), {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function tournamentStatus(tournament: Tournament | null, futureLabel = "Próximamente") {
  if (!tournament) return { label: futureLabel, className: "is-upcoming" };
  const labels = {
    open: "Inscripción abierta",
    in_progress: "En competencia",
    completed: "Finalizado",
    cancelled: "Cancelado",
  } as const;
  return {
    label: labels[tournament.status],
    className: `is-${tournament.status.replace("_", "-")}`,
  };
}

function qualifierViewerMarkup(response: QualifierTournamentResponse) {
  const viewer = response.viewer;
  if (!viewer?.registered) return "";
  if (viewer.qualified) {
    return `<div class="tournament-viewer is-qualified"><span>✓</span><p><b>Clasificaste al Campeonato Mundial</b><small>Tu cupo quedó asegurado en esta edición.</small></p></div>`;
  }
  if (viewer.eliminated) {
    return `<div class="tournament-viewer is-eliminated"><span>•</span><p><b>Participación finalizada</b><small>Alcanzaste el límite de dos derrotas.</small></p></div>`;
  }
  return `<div class="tournament-viewer"><span>${flag(viewer.countryCode || currentUser?.countryCode || "")}</span><p><b>Inscripción confirmada</b><small>Representas a ${escapeHtml(viewer.countryCode || currentUser?.countryCode || "tu país")} en esta edición.</small></p></div>`;
}

function tournamentParticipantCards(participants: TournamentParticipant[]) {
  if (!participants.length) {
    return `<div class="tournament-participants-empty"><span>${icon("users")}</span><b>Aún no hay jugadores inscritos</b><p>Los perfiles aparecerán aquí cuando se confirme la primera inscripción.</p></div>`;
  }
  return participants.map((participant) => `<button class="tournament-participant-card" type="button" data-player-profile-link="${escapeHtml(participant.username)}" aria-label="Ver perfil de ${escapeHtml(participant.name)}">
    ${avatarMarkup(participant, "avatar avatar--tournament")}
    <span><span class="tournament-participant-name"><b>${escapeHtml(participant.name)}</b>${worldTrophyMarkup(participant)}</span><small>${flag(participant.countryCode)} @${escapeHtml(participant.username)}</small>${worldTitleRecognitionMarkup(participant, "world-title-recognition--compact")}<em class="elo-tier-badge">${escapeHtml(participant.tier ?? eloTier(participant.rating))}</em></span>
    <strong>${participant.rating.toLocaleString(localeCode())}<small>Elo Damas</small></strong>
    <i aria-hidden="true">→</i>
  </button>`).join("");
}

function tournamentPlayerProfileMarkup(
  response: Awaited<ReturnType<typeof api.playerStatistics>>,
  backLabel = "Todos los inscritos",
) {
  const profile = response.profile;
  const mode = response.modes.find((item) => item.boardSize === 10) ?? response.modes[0];
  const joined = profile.memberSince
    ? new Date(profile.memberSince).toLocaleDateString(localeCode(), { month: "short", year: "numeric" })
    : "—";
  return `<section class="tournament-player-profile">
    <button class="tournament-profile-back" type="button" data-back-participants>← ${escapeHtml(backLabel)}</button>
    <div class="tournament-profile-hero">
      ${avatarMarkup(profile, "avatar avatar--tournament-profile")}
      <span><small>PERFIL COMPETITIVO</small><h3><span>${escapeHtml(profile.name)}</span>${worldTrophyMarkup(profile, "world-trophy--profile")}</h3><p>${flag(profile.countryCode)} @${escapeHtml(profile.username)}</p><em class="elo-tier-badge">${escapeHtml(mode?.tier ?? eloTier(mode?.rating ?? 1200))}</em>${profile.worldTitle ? `<strong class="world-profile-title">PODIO MUNDIAL VIGENTE · ${escapeHtml(WORLD_TROPHY_DETAILS[profile.worldTitle.placement].podiumLabel)}</strong>` : ""}</span>
      ${!profile.isSelf ? `<button class="button ${profile.isFollowing ? "button--quiet" : "button--primary"} button--small" type="button" data-follow-tournament-player="${escapeHtml(profile.username)}" ${profile.isFollowing ? "disabled" : ""}>${profile.isFollowing ? "✓ En tus amigos" : `${icon("userPlus")} Agregar amigo`}</button>` : `<span class="tournament-own-profile">Tu perfil</span>`}
    </div>
    <div class="tournament-profile-rating"><span><small>Elo Damas</small><b>${mode?.rating?.toLocaleString(localeCode()) ?? (1200).toLocaleString(localeCode())}</b></span><span><small>Mejor Elo</small><b>${mode?.peakRating?.toLocaleString(localeCode()) ?? mode?.rating?.toLocaleString(localeCode()) ?? (1200).toLocaleString(localeCode())}</b></span><span><small>Ranking mundial</small><b>${mode?.worldPosition ? `#${mode.worldPosition}` : "—"}</b></span><span><small>Ranking nacional</small><b>${mode?.countryPosition ? `#${mode.countryPosition}` : "—"}</b></span></div>
    <div class="tournament-profile-record"><span><b>${response.summary.totalGames}</b><small>Partidas</small></span><span><b>${response.summary.wins}</b><small>Victorias</small></span><span><b>${response.summary.winRate}%</b><small>Rendimiento</small></span><span><b>${profile.followerCount}</b><small>Seguidores</small></span></div>
    <div class="tournament-profile-meta"><span><small>Miembro desde</small><b>${escapeHtml(joined)}</b></span><span><small>Actividad reciente</small><b>${response.summary.gamesLast30Days} partidas en 30 días</b></span><span><small>Promedio</small><b>${response.summary.averageMoves || 0} movimientos</b></span></div>
  </section>`;
}

function playerMatchEndLabel(match: PlayerMatchHistoryEntry) {
  if (match.result === "draw") {
    return match.endReason === "agreement"
      ? "Tablas por acuerdo"
      : "La partida terminó en tablas";
  }
  if (match.endReason === "timeout") {
    return match.result === "win"
      ? "El rival perdió por tiempo"
      : "Perdió por tiempo";
  }
  if (match.endReason === "resignation") {
    return match.result === "win"
      ? "El rival se rindió"
      : "Se rindió ante el rival";
  }
  if (match.endReason === "withdrawal") {
    return match.result === "win"
      ? "El rival abandonó la partida"
      : "Abandonó la partida";
  }
  return match.result === "win"
    ? "Victoria decidida en el tablero"
    : "Derrota decidida en el tablero";
}

function playerMatchHistoryMarkup(
  matches: PlayerMatchHistoryEntry[],
  hasMore: boolean,
) {
  const history = matches.length
    ? matches.map((match) => {
        const resultLabel = match.result === "win"
          ? "Venció"
          : match.result === "loss"
            ? "Perdió"
            : "Tablas";
        const versusLabel = match.result === "win"
          ? "Venció a"
          : match.result === "loss"
            ? "Perdió ante"
            : "Tablas con";
        const date = new Date(match.createdAt);
        const playedAt = Number.isNaN(date.getTime())
          ? "Fecha no disponible"
          : date.toLocaleString(localeCode(), {
              day: "numeric",
              month: "short",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            });
        return `<article class="profile-match-history-item is-${match.result}">
          <span class="profile-match-result-symbol" aria-hidden="true">${match.result === "win" ? "✓" : match.result === "loss" ? "×" : "½"}</span>
          <div class="profile-match-history-copy">
            <span class="profile-match-result-label">${resultLabel}</span>
            <h3>${versusLabel} <button type="button" data-player-profile-link="${escapeHtml(match.opponentUsername)}">${flag(match.opponentCountryCode)} ${escapeHtml(match.opponentName)} <small>@${escapeHtml(match.opponentUsername)}</small></button></h3>
            <p>${escapeHtml(playerMatchEndLabel(match))}</p>
          </div>
          <div class="profile-match-history-meta">
            <time datetime="${escapeHtml(match.createdAt)}">${escapeHtml(playedAt)}</time>
            <span>${match.timeControlMinutes} min${match.durationSeconds ? ` · ${formatDuration(match.durationSeconds)}` : ""}</span>
          </div>
        </article>`;
      }).join("")
    : `<div class="profile-match-history-empty"><span>♟</span><b>Aún no hay enfrentamientos registrados</b><p>Los resultados aparecerán aquí después de completar una partida clasificada.</p></div>`;

  return `<div class="profile-match-history-list">${history}</div>
    ${hasMore ? `<div class="profile-match-history-actions"><button class="button button--quiet" type="button" data-view-more-history>Ver más</button><small>Se cargarán ${LIST_PAGE_SIZE} enfrentamientos adicionales.</small></div>` : ""}`;
}

function playerMatchHistorySectionMarkup() {
  return `<section class="player-profile-history" aria-labelledby="player-profile-history-title">
    <header>
      <div><span class="section-kicker">RESULTADOS RECIENTES</span><h2 id="player-profile-history-title">Historial de enfrentamientos</h2><p>Se carga solo cuando lo solicitas y muestra ${LIST_PAGE_SIZE} partidas a la vez.</p></div>
      <button class="button button--quiet" type="button" data-view-player-history>Ver historial</button>
      <b data-player-history-count hidden></b>
    </header>
    <div data-player-history-results hidden aria-live="polite"></div>
  </section>`;
}

function playerProfilePageMarkup(
  response: Awaited<ReturnType<typeof api.playerStatistics>>,
) {
  const profile = response.profile;
  const mode = response.modes.find((item) => item.boardSize === 10) ?? response.modes[0];
  const rating = mode?.rating ?? 1200;
  const joined = profile.memberSince
    ? new Date(profile.memberSince).toLocaleDateString(localeCode(), {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "—";
  const title = profile.worldTitle
    ? WORLD_TROPHY_DETAILS[profile.worldTitle.placement]
    : null;
  return `
    <section class="page-heading player-profile-heading">
      <div><button class="text-button" type="button" data-route="/comunidad">← Comunidad</button><span class="eyebrow"><i></i>PERFIL DE JUGADOR</span><h1 class="profile-heading-name"><span>${escapeHtml(profile.name)}</span>${worldTrophyMarkup(profile, "world-trophy--heading")}</h1><p>${flag(profile.countryCode)} @${escapeHtml(profile.username)} · Damas internacionales 10×10</p></div>
      ${profile.isSelf
        ? `<button class="button button--quiet" type="button" data-open-profile-photo>${icon("camera")} Cambiar foto</button>`
        : `<div class="player-profile-actions">
            <button class="button button--primary" type="button" data-challenge-profile="${escapeHtml(profile.username)}">${icon("play")} Desafiar a @${escapeHtml(profile.username)}</button>
            ${profile.isFollowing
              ? `<button class="button button--quiet player-profile-unfollow" type="button" data-unfollow-profile="${escapeHtml(profile.username)}">✓ Dejar de seguir</button>`
              : `<button class="button button--quiet" type="button" data-follow-profile="${escapeHtml(profile.username)}">${icon("userPlus")} Seguir</button>`}
          </div>`}
    </section>
    <section class="panel player-profile-card">
      <div class="player-profile-hero">
        ${avatarMarkup(profile, "avatar avatar--public-profile")}
        <div><small>${escapeHtml(mode?.tier ?? eloTier(rating))}</small><h2><span>${escapeHtml(profile.name)}</span>${worldTrophyMarkup(profile, "world-trophy--public-profile")}</h2><p>${flag(profile.countryCode)} @${escapeHtml(profile.username)}</p></div>
        <div class="player-profile-followers"><button type="button" data-view-followers aria-label="Ver quién sigue a @${escapeHtml(profile.username)}"><b>${profile.followerCount}</b><small>Seguidores <i aria-hidden="true">→</i></small></button><button type="button" data-view-following aria-label="Ver a quién sigue @${escapeHtml(profile.username)}"><b>${profile.followingCount}</b><small>Siguiendo <i aria-hidden="true">→</i></small></button></div>
      </div>
      ${title ? `<div class="player-world-title is-${profile.worldTitle?.placement}">${worldTrophyMarkup(profile, "world-trophy--profile-banner")}<span><small>PODIO MUNDIAL VIGENTE</small><b>${escapeHtml(title.label)}</b><p>Trofeo oficial y pase directo al próximo Campeonato Mundial.</p></span></div>` : ""}
      <div class="player-profile-rating"><span><small>Elo Damas</small><b>${rating.toLocaleString(localeCode())}</b></span><span><small>Mejor Elo</small><b>${(mode?.peakRating ?? rating).toLocaleString(localeCode())}</b></span><span><small>Ranking mundial</small><b>${mode?.worldPosition ? `#${mode.worldPosition}` : "—"}</b></span><span><small>Ranking nacional</small><b>${mode?.countryPosition ? `#${mode.countryPosition}` : "—"}</b></span></div>
      <div class="player-profile-record"><span><b>${response.summary.totalGames}</b><small>Partidas</small></span><span><b>${response.summary.wins}</b><small>Victorias</small></span><span><b>${response.summary.losses}</b><small>Derrotas</small></span><span><b>${response.summary.draws}</b><small>Tablas</small></span><span><b>${response.summary.winRate}%</b><small>Rendimiento</small></span></div>
      <div class="player-profile-details"><span><small>Miembro desde</small><b>${escapeHtml(joined)}</b></span><span><small>Últimos 30 días</small><b>${response.summary.gamesLast30Days} partidas</b></span><span><small>Promedio por partida</small><b>${response.summary.averageMoves || 0} movimientos</b></span><span><small>Duración promedio</small><b>${formatDuration(response.summary.averageDuration || 0)}</b></span></div>
      ${playerMatchHistorySectionMarkup()}
    </section>
    <dialog class="profile-following-dialog" aria-labelledby="profile-following-title">
      <header><div><span class="section-kicker">CÍRCULO DE JUGADORES</span><h2 id="profile-following-title" data-social-list-title>Personas que sigue @${escapeHtml(profile.username)}</h2><p><b data-social-list-count>${profile.followingCount}</b> <span data-social-list-count-label>${profile.followingCount === 1 ? "perfil" : "perfiles"}</span></p></div><button type="button" data-close-profile-following aria-label="Cerrar">×</button></header>
      <div class="profile-following-list" data-profile-following-list></div>
    </dialog>`;
}

function profileSocialListMarkup(
  users: User[],
  kind: "followers" | "following",
  hasMore = false,
) {
  if (!users.length) {
    return kind === "followers"
      ? `<div class="profile-following-empty"><span>${icon("users")}</span><b>Aún no tiene seguidores</b><p>Las personas que sigan este perfil aparecerán aquí.</p></div>`
      : `<div class="profile-following-empty"><span>${icon("users")}</span><b>Aún no sigue a ningún jugador</b><p>Cuando agregue personas a su círculo, aparecerán aquí.</p></div>`;
  }
  const profiles = users.map((user) => `<button class="profile-following-player" type="button" data-player-profile-link="${escapeHtml(user.username)}" aria-label="Ver perfil de ${escapeHtml(user.name)}">
    ${avatarMarkup(user, "avatar avatar--profile-following")}
    <span><span class="player-name-with-title"><b>${escapeHtml(user.name)}</b>${worldTrophyMarkup(user)}</span><small>${flag(user.countryCode)} @${escapeHtml(user.username)}</small>${worldTitleRecognitionMarkup(user, "world-title-recognition--compact")}</span>
    <i aria-hidden="true">→</i>
  </button>`).join("");
  return `${profiles}${hasMore ? `<div class="profile-following-more"><button class="button button--quiet button--small" type="button" data-view-more-social>Ver más</button><small>Se cargarán ${LIST_PAGE_SIZE} perfiles adicionales.</small></div>` : ""}`;
}

async function renderPlayerProfile(username: string) {
  root.innerHTML = appLayout(loadingMarkup(`Cargando el perfil de @${username}…`), "community");
  bindNavigation();
  try {
    const response = await api.playerStatistics(username);
    if (route() !== `/perfil/${username}`) return;
    root.innerHTML = appLayout(playerProfilePageMarkup(response), "community");
    bindNavigation();
    root.querySelector<HTMLButtonElement>("[data-challenge-profile]")?.addEventListener("click", () => {
      openProfileChallenge(response.profile);
    });
    const historyButton = root.querySelector<HTMLButtonElement>("[data-view-player-history]");
    const historyCount = root.querySelector<HTMLElement>("[data-player-history-count]");
    const historyResults = root.querySelector<HTMLElement>("[data-player-history-results]");
    const loadedMatches: PlayerMatchHistoryEntry[] = [];
    let nextHistoryOffset = 0;
    let historyLoading = false;
    const loadPlayerHistory = async () => {
      if (historyLoading || !historyButton || !historyResults) return;
      historyLoading = true;
      const firstPage = loadedMatches.length === 0;
      const trigger = firstPage
        ? historyButton
        : historyResults.querySelector<HTMLButtonElement>("[data-view-more-history]");
      if (trigger) {
        trigger.disabled = true;
        trigger.textContent = "Cargando…";
      }
      try {
        const page = await api.playerHistory(username, nextHistoryOffset);
        if (route() !== `/perfil/${username}`) return;
        loadedMatches.push(...page.matches);
        nextHistoryOffset = page.nextOffset;
        historyResults.innerHTML = playerMatchHistoryMarkup(loadedMatches, page.hasMore);
        historyResults.hidden = false;
        historyButton.hidden = true;
        if (historyCount) {
          historyCount.textContent = `${loadedMatches.length} ${loadedMatches.length === 1 ? "partida mostrada" : "partidas mostradas"}`;
          historyCount.hidden = false;
        }
        historyResults.querySelector<HTMLButtonElement>("[data-view-more-history]")
          ?.addEventListener("click", () => void loadPlayerHistory());
      } catch (error) {
        if (trigger) {
          trigger.disabled = false;
          trigger.textContent = firstPage ? "Ver historial" : "Ver más";
        }
        toast(errorMessage(error), "error");
      } finally {
        historyLoading = false;
      }
    };
    historyButton?.addEventListener("click", () => void loadPlayerHistory());
    root.querySelectorAll<HTMLButtonElement>("[data-follow-profile], [data-unfollow-profile]").forEach((button) => {
      button.addEventListener("click", async () => {
        const unfollowing = button.hasAttribute("data-unfollow-profile");
        button.disabled = true;
        try {
          if (unfollowing) await api.unfollow(username);
          else await api.follow(username);
          toast(unfollowing
            ? `Dejaste de seguir a @${username}.`
            : `Ahora sigues a @${username}.`);
          await renderPlayerProfile(username);
        } catch (error) {
          button.disabled = false;
          toast(errorMessage(error), "error");
        }
      });
    });
    const followingDialog = root.querySelector<HTMLDialogElement>(".profile-following-dialog");
    const followingList = followingDialog?.querySelector<HTMLElement>("[data-profile-following-list]");
    const socialTitle = followingDialog?.querySelector<HTMLElement>("[data-social-list-title]");
    const socialCount = followingDialog?.querySelector<HTMLElement>("[data-social-list-count]");
    const socialCountLabel = followingDialog?.querySelector<HTMLElement>("[data-social-list-count-label]");
    let socialListVersion = 0;
    let socialUsers: User[] = [];
    let socialOffset = 0;
    let socialLoading = false;
    const closeFollowing = () => {
      socialListVersion += 1;
      followingDialog?.close();
    };
    const loadSocialList = async (
      kind: "followers" | "following",
      version: number,
      firstPage: boolean,
    ) => {
      if (!followingList || socialLoading) return;
      socialLoading = true;
      const moreButton = followingList.querySelector<HTMLButtonElement>("[data-view-more-social]");
      if (moreButton) {
        moreButton.disabled = true;
        moreButton.textContent = "Cargando…";
      }
      try {
        const offset = firstPage ? 0 : socialOffset;
        const result = kind === "followers"
          ? await api.followers(username, offset)
          : await api.following(username, offset);
        if (version !== socialListVersion || !followingList.isConnected) return;
        socialUsers.push(...result.users);
        socialOffset = result.nextOffset;
        followingList.innerHTML = profileSocialListMarkup(
          socialUsers,
          kind,
          result.hasMore,
        );
        followingList
          .querySelector<HTMLButtonElement>("[data-view-more-social]")
          ?.addEventListener("click", () => {
            void loadSocialList(kind, version, false);
          });
      } catch (error) {
        if (version === socialListVersion && followingList.isConnected) {
          followingList.innerHTML = `<div class="profile-following-empty"><span>!</span><b>No pudimos cargar los perfiles</b><p>${escapeHtml(errorMessage(error))}</p></div>`;
        }
      } finally {
        if (version === socialListVersion) socialLoading = false;
      }
    };
    const openSocialList = (kind: "followers" | "following") => {
      if (!followingDialog || !followingList) return;
      const count = kind === "followers"
        ? response.profile.followerCount
        : response.profile.followingCount;
      const version = ++socialListVersion;
      socialUsers = [];
      socialOffset = 0;
      socialLoading = false;
      if (socialTitle) {
        socialTitle.textContent = kind === "followers"
          ? `Seguidores de @${username}`
          : `Personas que sigue @${username}`;
      }
      if (socialCount) socialCount.textContent = String(count);
      if (socialCountLabel) socialCountLabel.textContent = count === 1 ? "perfil" : "perfiles";
      followingList.innerHTML = `<div class="profile-following-loading"><span class="loader"></span><p>Cargando perfiles…</p></div>`;
      followingDialog.showModal();
      void loadSocialList(kind, version, true);
    };
    root.querySelector<HTMLButtonElement>("[data-view-followers]")
      ?.addEventListener("click", () => openSocialList("followers"));
    root.querySelector<HTMLButtonElement>("[data-view-following]")
      ?.addEventListener("click", () => openSocialList("following"));
    followingDialog?.querySelector("[data-close-profile-following]")?.addEventListener("click", closeFollowing);
    followingDialog?.addEventListener("click", (event) => {
      if (event.target === followingDialog) closeFollowing();
    });
  } catch (error) {
    root.innerHTML = appLayout(errorState(errorMessage(error)), "community");
    bindNavigation();
    bindRetry(() => void renderPlayerProfile(username));
  }
}

function qualifierMatchDate(value: string) {
  return new Date(value).toLocaleDateString(localeCode(), {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function qualifierBracketPlayerMarkup(
  player: QualifierBracketPlayer | null,
  match: QualifierBracketMatch,
) {
  if (!player) {
    return `<span class="qualifier-bracket-player is-pending"><i>?</i><span><b>Rival por confirmar</b><small>Próxima inscripción del país</small></span></span>`;
  }
  const winner = match.winnerId === player.id;
  return playerProfileButton(player, `
    ${avatarMarkup(player, "avatar avatar--bracket")}
    <span><span class="player-name-with-title"><b>${escapeHtml(player.name)}</b>${worldTrophyMarkup(player)}</span><small>@${escapeHtml(player.username)} · ${player.rating.toLocaleString(localeCode())}</small></span>
    ${winner ? "<i>✓</i>" : ""}
  `, `qualifier-bracket-player ${winner ? "is-winner" : ""}`);
}

function qualifierBracketMarkup(bracket: QualifierBracketResponse) {
  const countryCode = bracket.countryCode || currentUser?.countryCode || "DO";
  const viewer = bracket.viewer;
  const viewerCallout = !viewer.registered
    ? `<div class="qualifier-viewer-match"><span>${icon("tournament")}</span><p><small>TU PRIMER CRUCE</small><b>Inscríbete para reservar tu lugar</b><em>El rival se asigna por orden de inscripción dentro de tu país.</em></p></div>`
    : viewer.participant.state === "qualified"
      ? `<div class="qualifier-viewer-match is-qualified"><span>✓</span><p><small>RESULTADO FINAL</small><b>Clasificaste al Campeonato Mundial</b><em>Ocupas uno de los tres cupos oficiales de ${flag(countryCode)} ${escapeHtml(countryCode)}.</em></p></div>`
      : viewer.participant.state === "eliminated"
        ? `<div class="qualifier-viewer-match is-eliminated"><span>×</span><p><small>RESULTADO FINAL</small><b>Participación finalizada</b><em>El cuadro registra ${viewer.participant.losses} derrotas.</em></p></div>`
        : viewer.opponent
          ? `<div class="qualifier-viewer-match">${playerProfileButton(viewer.opponent, `${avatarMarkup(viewer.opponent, "avatar avatar--bracket-opponent")}<p><small>TU PRÓXIMO RIVAL · ${viewer.scheduledAt ? qualifierMatchDate(viewer.scheduledAt) : "FECHA POR CONFIRMAR"}</small><span class="player-name-with-title"><b>${escapeHtml(viewer.opponent.name)}</b>${worldTrophyMarkup(viewer.opponent)}</span><em>${flag(viewer.opponent.countryCode)} @${escapeHtml(viewer.opponent.username)} · ${viewer.opponent.rating.toLocaleString(localeCode())} Elo Damas</em>${worldTitleRecognitionMarkup(viewer.opponent, "world-title-recognition--compact")}</p>`, "qualifier-viewer-opponent")}</div>`
          : `<div class="qualifier-viewer-match is-waiting"><span>…</span><p><small>TU PRIMER CRUCE · ${viewer.scheduledAt ? qualifierMatchDate(viewer.scheduledAt) : "26 JUN 2027"}</small><b>Rival por confirmar</b><em>Quedarás emparejado con el próximo jugador disponible de tu país.</em></p></div>`;
  const qualifierSlots = Array.from({ length: bracket.rules.qualifyingPlaces }, (_, index) => bracket.qualifiers[index] || null);
  const stateLabels = {
    registered: "Inscrito",
    active: "En competencia",
    qualified: "Clasificado",
    eliminated: "Eliminado",
  } as const;
  return `<div class="qualifier-bracket-summary">
      <div><span class="section-kicker">CUADRO NACIONAL</span><h3>${flag(countryCode)} ${escapeHtml(countryCode)} · Camino a los 3 cupos</h3><p>${tournamentDate(bracket.window.startsAt)} – ${tournamentDate(bracket.window.endsAt)} · partidas semanales a las 20:00 UTC</p></div>
      ${bracket.countries.length > 1 ? `<label>País<select data-bracket-country>${bracket.countries.map((code) => `<option value="${escapeHtml(code)}" ${code === countryCode ? "selected" : ""}>${flag(code)} ${escapeHtml(code)}</option>`).join("")}</select></label>` : `<span class="qualifier-country-lock">${flag(countryCode)} ${escapeHtml(countryCode)}</span>`}
    </div>
    <div class="qualifier-bracket-facts"><span><b>${bracket.rules.qualifyingPlaces}</b><small>Cupos al Mundial</small></span><span><b>${bracket.rules.lossesToEliminate}</b><small>Derrotas eliminan</small></span><span><b>${bracket.rules.timeControlMinutes}</b><small>Minutos por jugador</small></span><span><b>${bracket.participants.length}</b><small>Inscritos del país</small></span></div>
    ${viewerCallout}
    <section class="qualifier-final-slots"><header><span><small>META DEL CUADRO</small><h3>Los tres clasificados</h3></span><p>Solo estos tres puestos avanzan al Campeonato Mundial.</p></header><div>${qualifierSlots.map((player, index) => player
      ? `<span class="is-filled"><i>${index + 1}</i>${playerProfileButton(player, `${avatarMarkup(player, "avatar avatar--qualifier-slot")}<p><span class="player-name-with-title"><b>${escapeHtml(player.name)}</b>${worldTrophyMarkup(player)}</span><small>@${escapeHtml(player.username)}</small></p>`, "qualifier-slot-profile")}<em>CLASIFICADO</em></span>`
      : `<span><i>${index + 1}</i><div class="qualifier-slot-pending">?</div><p><b>Cupo por definir</b><small>Avanza un sobreviviente</small></p></span>`).join("")}</div></section>
    <section class="qualifier-calendar"><header><span><small>CALENDARIO OFICIAL</small><h3>Fechas de ronda</h3></span><p>El cuadro se actualiza automáticamente después de completar cada ronda.</p></header><div>${bracket.calendar.map((entry) => `<span class="${bracket.rounds.some((round) => round.round === entry.round) ? "has-matches" : ""}"><small>R${entry.round}</small><b>${qualifierMatchDate(entry.scheduledAt).replace(/ de /g, " ")}</b></span>`).join("")}</div></section>
    <section class="qualifier-rounds"><header><span><small>ENFRENTAMIENTOS</small><h3>${bracket.tournament.status === "open" ? "Primera ronda provisional" : "Cuadro en vivo"}</h3></span><p>${bracket.tournament.status === "open" ? "Los pares se asignan por orden de inscripción; el último jugador sin pareja espera la siguiente inscripción." : "Los ganadores continúan y dos derrotas eliminan."}</p></header>
      <div class="qualifier-round-columns">${bracket.rounds.length ? bracket.rounds.map((round) => `<article class="qualifier-round-column"><header><span><small>RONDA ${round.round}</small><b>${qualifierMatchDate(round.scheduledAt)}</b></span><em class="is-${round.status}">${round.status === "in_progress" ? "En juego" : round.status === "completed" ? "Completada" : "Programada"}</em></header><div>${round.matches.map((match) => `<article class="qualifier-match ${match.status === "pending_opponent" ? "is-pending" : ""}">${qualifierBracketPlayerMarkup(match.ivory, match)}<i>VS</i>${qualifierBracketPlayerMarkup(match.mahogany, match)}<footer>${match.provisional ? "Cruce reservado por inscripción" : match.status === "active" ? "Partida disponible" : match.status === "completed" ? "Resultado confirmado" : "Partida cerrada"}</footer></article>`).join("")}</div></article>`).join("") : `<div class="qualifier-bracket-empty"><span>${icon("users")}</span><b>Esperando jugadores de ${flag(countryCode)} ${escapeHtml(countryCode)}</b><p>El primer cruce aparecerá cuando se confirme una inscripción.</p></div>`}</div>
    </section>
    <section class="qualifier-participant-status"><header><span><small>ESTADO DEL PAÍS</small><h3>Jugadores en ruta</h3></span></header><div>${bracket.participants.length ? bracket.participants.map((player) => `<span>${playerProfileButton(player, `${avatarMarkup(player, "avatar avatar--bracket-status")}<p><span class="player-name-with-title"><b>${escapeHtml(player.name)}</b>${worldTrophyMarkup(player)}</span><small>@${escapeHtml(player.username)} · ${escapeHtml(player.tier)}</small></p>`, "qualifier-status-profile")}<strong>${player.losses}<small>derrotas</small></strong><em class="is-${player.state}">${stateLabels[player.state]}</em></span>`).join("") : `<p class="qualifier-status-empty">Todavía no hay jugadores inscritos en este país.</p>`}</div></section>
    <p class="qualifier-bracket-note">Los cruces son nacionales y dinámicos. Si una ronda tiene un número impar de jugadores, uno descansa; el sistema rota ese descanso y evita repetir rivales cuando existe otra pareja disponible.</p>`;
}

function worldTitleHoldersMarkup(world: WorldChampionshipResponse) {
  const holders = world.titleHolders ?? [];
  if (!holders.length) return "";
  const placeLabel = { gold: "Primer lugar", silver: "Segundo lugar", bronze: "Tercer lugar" } as const;
  return `<section class="world-title-holders">
    <header><span><small>PODIO MUNDIAL VIGENTE</small><h3>Campeones con pase directo</h3></span><p>Conservan el trofeo hasta que el próximo Campeonato Mundial defina un nuevo podio.</p></header>
    <div>${holders.map((holder) => `<button class="world-title-holder is-${holder.worldTitle.placement}" type="button" data-player-profile-link="${escapeHtml(holder.username)}" aria-label="Ver perfil de ${escapeHtml(holder.name)}">
      ${worldTrophyMarkup(holder, "world-trophy--podium")}
      ${avatarMarkup(holder, "avatar avatar--world-holder")}
      <span><small>${placeLabel[holder.worldTitle.placement]}</small><b>${escapeHtml(holder.name)}</b><em>${flag(holder.countryCode)} @${escapeHtml(holder.username)}</em></span>
      <strong>✓ PASE DIRECTO</strong><i aria-hidden="true">›</i>
    </button>`).join("")}</div>
  </section>`;
}

type TournamentPayment =
  | {
      kind: "paypal";
      config: Awaited<ReturnType<typeof api.donationConfig>>;
    }
  | {
      kind: "app-store";
      config: AppStoreConfig;
      product: NativeStoreProduct | null;
    };

function tournamentsMarkup(
  qualifier: QualifierTournamentResponse,
  world: WorldChampionshipResponse,
  payment: TournamentPayment,
  participantPage: Awaited<ReturnType<typeof api.tournamentParticipants>>,
) {
  const { participants } = participantPage;
  const participantTotal = participantPage.total;
  const qualifierTournament = qualifier.tournament;
  const qualifierYear = qualifierTournament?.qualifierYear
    ?? Math.max(2027, new Date(qualifier.registrationStartsAt || Date.now()).getUTCFullYear());
  const worldTournament = world.tournament;
  const worldYear = worldTournament?.championshipYear ?? new Date(world.nextStartsAt).getUTCFullYear();
  const qualifierState = tournamentStatus(qualifierTournament, "Próxima inscripción");
  const worldState = tournamentStatus(worldTournament, "Próxima edición");
  const entryFee = Number(qualifier.entryFee.amount).toFixed(2);
  const entryPrice = payment.kind === "app-store"
    ? payment.product?.displayPrice || `${qualifier.entryFee.currency} $${entryFee}`
    : `$${entryFee}`;
  const canRegister = Boolean(
    qualifierTournament?.status === "open" && !qualifier.viewer?.registered,
  );
  const viewerHasWorldPlace = Boolean(
    worldTournament?.isParticipant || world.viewer?.directlyQualified,
  );
  const registrationEnd = new Date(Date.UTC(qualifierYear, 5, 25, 23, 59, 59));
  const qualifierStarts = new Date(Date.UTC(qualifierYear, 5, 26));
  const qualifierEnds = new Date(Date.UTC(qualifierYear, 8, 25, 23, 59, 59));
  const worldStarts = worldTournament?.startedAt
    ? new Date(worldTournament.startedAt)
    : new Date(world.nextStartsAt);
  const worldEnds = new Date(Date.UTC(worldYear, 11, 28, 23, 59, 59));
  return `
    <section class="page-heading tournaments-heading">
      <div><span class="eyebrow"><i></i>RUTA AL TÍTULO MUNDIAL</span><h1>Torneos</h1><p>Dos competencias, un solo camino para coronar al mejor jugador de damas 10×10.</p></div>
      <div class="tournament-season"><span>${icon("tournament")}</span><p><small>TEMPORADA</small><b>${qualifierYear}</b></p></div>
    </section>
    <div class="tournament-road" aria-label="Camino al Campeonato Mundial">
      <span class="is-current"><i>1</i><b>Clasificatoria</b><small>Por países</small></span>
      <em><i></i></em>
      <span><i>2</i><b>Campeonato Mundial</b><small>Final internacional</small></span>
    </div>
    <div class="tournament-cards">
      <article class="panel tournament-card tournament-card--qualifier">
        <header><span class="tournament-emblem">${icon("users")}</span><div><small>ETAPA 1 · ${qualifierYear}</small><h2>Clasificación al<br>Campeonato Mundial</h2></div><div class="tournament-header-actions"><span class="tournament-status ${qualifierState.className}"><i></i>${qualifierState.label}</span>${canRegister ? `<button class="button button--primary tournament-entry-button tournament-entry-button--top" type="button" data-open-tournament-entry>${icon("tournament")} Inscribirme por ${escapeHtml(entryPrice)}</button>` : ""}</div></header>
        <p class="tournament-description">Compite contra jugadores de tu país. Sobrevive a las rondas y gana uno de los cupos para representar a tu bandera.</p>
        <div class="tournament-facts"><span><small>Modalidad</small><b>10 × 10</b></span><span><small>Reloj</small><b>30 min</b></span><span><small>Inscripción</small><b>${escapeHtml(entryPrice)}</b></span><span><small>Participantes</small><b>${qualifierTournament?.participantCount ?? 0}</b></span></div>
        <div class="tournament-timeline">
          <span class="is-active"><i></i><p><small>INSCRIPCIÓN HASTA</small><b>${tournamentDate(registrationEnd)}</b></p></span>
          <span><i></i><p><small>COMPETENCIA</small><b>${tournamentDate(qualifierStarts)} – ${tournamentDate(qualifierEnds)}</b></p></span>
        </div>
        <section class="tournament-registered-preview">
          <div><small>PERFILES DEL TORNEO</small><h3>Jugadores inscritos</h3></div>
          <div class="tournament-avatar-stack">${participants.map((participant) => playerProfileButton(participant, avatarMarkup(participant, "avatar avatar--tournament-stack"), "tournament-stack-profile")).join("")}${participantTotal > participants.length ? `<span>+${participantTotal - participants.length}</span>` : ""}</div>
          <strong>${participantTotal}<small>${participantTotal === 1 ? "jugador" : "jugadores"}</small></strong>
          <button type="button" data-open-tournament-participants ${qualifierTournament ? "" : "disabled"}>Ver perfiles →</button>
        </section>
        <button class="tournament-bracket-trigger" type="button" data-open-qualifier-bracket ${qualifierTournament ? "" : "disabled"}><span>${icon("tournament")}</span><p><small>CUADRO DE ENFRENTAMIENTOS</small><b>Ver rivales y fechas</b></p><strong>3 cupos <i>→</i></strong></button>
        <ul class="tournament-rules"><li><span>2</span><p><b>Dos derrotas eliminan</b><small>Cada país avanza por rondas independientes.</small></p></li><li><span>3</span><p><b>Tres clasificados por país</b><small>Los últimos tres jugadores activos obtienen su cupo.</small></p></li><li><span>7d</span><p><b>Rondas cada semana</b><small>El cuadro evita repetir rivales cuando hay otra opción.</small></p></li></ul>
        ${qualifierViewerMarkup(qualifier)}
        ${!qualifierTournament ? `<div class="tournament-callout">La inscripción abre el ${tournamentDate(qualifier.registrationStartsAt || qualifierStarts)}.</div>` : !qualifier.viewer?.registered && qualifierTournament.status !== "open" ? `<div class="tournament-callout">La inscripción de esta edición ya está cerrada.</div>` : ""}
      </article>
      <article class="panel tournament-card tournament-card--world">
        <header><span class="tournament-emblem">${icon("crown")}</span><div><small>ETAPA 2 · ${worldYear}</small><h2>Campeonato<br>Mundial</h2></div><span class="tournament-status ${worldState.className}"><i></i>${worldState.label}</span></header>
        <p class="tournament-description">Los representantes de cada país se enfrentan en la máxima competencia anual de King Damas.</p>
        <div class="tournament-facts"><span><small>Modalidad</small><b>10 × 10</b></span><span><small>Reloj</small><b>30 min</b></span><span><small>Inicio</small><b>${tournamentDate(worldStarts)}</b></span><span><small>Final</small><b>${tournamentDate(worldEnds)}</b></span></div>
        ${worldTitleHoldersMarkup(world)}
        <div class="world-prizes"><small>DISTRIBUCIÓN DEL FONDO DE PREMIOS</small><div><span class="is-gold"><i>1</i><b>20%</b><small>Campeón</small></span><span class="is-silver"><i>2</i><b>10%</b><small>Segundo</small></span><span class="is-bronze"><i>3</i><b>5%</b><small>Tercero</small></span></div>${worldTournament?.prizePool ? `<p>Fondo actual: <b>${worldTournament.prizePool.currency} ${worldTournament.prizePool.amount.toLocaleString(localeCode())}</b></p>` : ""}</div>
        <ul class="tournament-rules"><li><span>🌎</span><p><b>Representación internacional</b><small>Clasificados por país y los tres campeones vigentes.</small></p></li><li><span>↻</span><p><b>Todos contra todos</b><small>Cada participante enfrenta a cada rival una vez.</small></p></li><li><span>♛</span><p><b>El podio cambia de dueño</b><small>Los tres mejores reciben los trofeos hasta la siguiente edición.</small></p></li></ul>
        ${viewerHasWorldPlace ? `<div class="tournament-viewer is-qualified"><span>✓</span><p><b>${world.viewer?.directlyQualified ? "Tu pase directo al Mundial está confirmado" : "Estás en el Campeonato Mundial"}</b><small>${world.viewer?.directlyQualified ? "Eres parte del podio vigente y no necesitas jugar la clasificatoria." : "Tu clasificación fue registrada automáticamente."}</small></p></div>` : `<div class="tournament-callout tournament-callout--world">El acceso es automático al clasificar por tu país. Los tres campeones vigentes conservan pase directo.</div>`}
      </article>
    </div>
    <dialog class="tournament-entry-dialog" aria-labelledby="tournament-entry-title">
      <button class="dialog-close" type="button" data-close-tournament-entry aria-label="Cerrar">×</button>
      <span class="tournament-entry-seal">${icon("tournament")}</span>
      <span class="section-kicker">INSCRIPCIÓN OFICIAL · ${qualifierYear}</span>
      <h2 id="tournament-entry-title">Representa a tu país</h2>
      <p>Tu inscripción corresponde a la Clasificación al Campeonato Mundial y se confirma al completar el pago.</p>
      <div class="tournament-entry-summary"><span><small>Modalidad</small><b>10 × 10</b></span><span><small>País</small><b>${flag(currentUser?.countryCode || "")} ${escapeHtml(currentUser?.countryCode || "")}</b></span><span><small>Total</small><b>${escapeHtml(entryPrice)}</b></span></div>
      <p class="tournament-entry-error" data-tournament-entry-error aria-live="polite"></p>
      <div class="tournament-paypal" data-tournament-payment>${payment.kind === "app-store"
        ? payment.config.enabled && payment.config.appAccountToken && payment.product
          ? `<button class="button button--app-store" type="button" data-purchase-tournament-ios> Inscribirme con App Store · ${escapeHtml(payment.product.displayPrice)}</button>`
          : `<div class="donation-sdk-error"><b>App Store no está disponible ahora mismo.</b><small>La inscripción no se puede procesar en esta versión.</small></div>`
        : payment.config.enabled
          ? `<span class="loader loader--small"></span><small>Preparando pago seguro…</small>`
          : `<div class="donation-sdk-error"><b>PayPal no está disponible ahora mismo.</b><small>Inténtalo nuevamente más tarde.</small></div>`}</div>
      <section class="tournament-official-rules"><b>Bases oficiales resumidas</b><ul><li>Organiza King Damas; competencia de habilidad en tablero 10×10.</li><li>Partidas de 30 minutos por jugador; dos derrotas eliminan y clasifican tres jugadores por país.</li><li>Inscripción hasta el ${tournamentDate(registrationEnd)}; competencia del ${tournamentDate(qualifierStarts)} al ${tournamentDate(qualifierEnds)}.</li><li>El Mundial distribuye 20%, 10% y 5% del fondo a los tres primeros puestos.</li></ul><small>Apple no patrocina, organiza ni participa en este torneo.</small></section>
      <small class="tournament-entry-note">Al continuar aceptas las bases oficiales. La inscripción no mejora tu Elo ni concede ventajas competitivas.</small>
    </dialog>
    <dialog class="tournament-participants-dialog" aria-labelledby="tournament-participants-title">
      <header><div><span class="section-kicker">PERFILES DE TORNEO</span><h2 id="tournament-participants-title" data-participants-title>Jugadores inscritos</h2><p data-participants-subtitle>${participantTotal} ${participantTotal === 1 ? "perfil confirmado" : "perfiles confirmados"}</p></div><button type="button" data-close-tournament-participants aria-label="Cerrar">×</button></header>
      <label class="tournament-participant-search" data-participant-search-wrap><span>${icon("search")}</span><input type="search" autocomplete="off" placeholder="Buscar en los inscritos…" data-participant-search /></label>
      <p class="tournament-participants-error" data-participants-error aria-live="polite"></p>
      <div class="tournament-participants-grid" data-participants-grid>${tournamentParticipantCards(participants)}${communityListMoreMarkup("tournament-participants", participantPage.hasMore)}</div>
    </dialog>
    <dialog class="qualifier-bracket-dialog" aria-labelledby="qualifier-bracket-title">
      <header><div><span class="section-kicker">CLASIFICATORIA ${qualifierYear}</span><h2 id="qualifier-bracket-title">Cuadro de enfrentamientos</h2><p>Del 26 de junio al 25 de septiembre · tres cupos por país</p></div><button type="button" data-close-qualifier-bracket aria-label="Cerrar">×</button></header>
      <div class="qualifier-bracket-content" data-qualifier-bracket-content><div class="tournament-profile-loading"><span class="loader"></span><p>Preparando el cuadro…</p></div></div>
    </dialog>`;
}

async function renderTournaments() {
  pageCleanup?.();
  pageCleanup = null;
  root.innerHTML = appLayout(loadingMarkup("Preparando los torneos…"), "tournaments");
  bindNavigation();
  try {
    const [qualifier, world] = await Promise.all([
      api.qualifierTournament(),
      api.worldChampionship(),
    ]);
    let payment: TournamentPayment;
    if (isIOSNativeApp()) {
      const config = await api.appStoreConfig();
      const tournamentProduct = config.products.tournamentEntry;
      const product = config.enabled && config.appAccountToken
        ? (await nativeStoreProducts([tournamentProduct.productId]))[0] || null
        : null;
      payment = { kind: "app-store", config, product };
    } else {
      payment = { kind: "paypal", config: await api.donationConfig() };
    }
    const participantPage = qualifier.tournament
      ? await api.tournamentParticipants(qualifier.tournament.id)
      : { participants: [], total: 0, nextOffset: 0, hasMore: false };
    root.innerHTML = appLayout(tournamentsMarkup(qualifier, world, payment, participantPage), "tournaments");
    bindNavigation();
    bindTournaments(qualifier, payment, participantPage);
  } catch (error) {
    root.innerHTML = appLayout(errorState(errorMessage(error)), "tournaments");
    bindNavigation();
    bindRetry(() => renderTournaments());
  }
}

function bindTournaments(
  qualifier: QualifierTournamentResponse,
  payment: TournamentPayment,
  initialParticipantPage: Awaited<ReturnType<typeof api.tournamentParticipants>>,
) {
  const tournament = qualifier.tournament;
  const dialog = root.querySelector<HTMLDialogElement>(".tournament-entry-dialog");
  const container = dialog?.querySelector<HTMLElement>("[data-tournament-payment]");
  const error = dialog?.querySelector<HTMLElement>("[data-tournament-entry-error]");
  let paymentButtons: PayPalButtonsInstance | null = null;
  let initializing = false;
  const participantsDialog = root.querySelector<HTMLDialogElement>(".tournament-participants-dialog");
  const participantsGrid = participantsDialog?.querySelector<HTMLElement>("[data-participants-grid]");
  const participantsTitle = participantsDialog?.querySelector<HTMLElement>("[data-participants-title]");
  const participantsSubtitle = participantsDialog?.querySelector<HTMLElement>("[data-participants-subtitle]");
  const participantSearchWrap = participantsDialog?.querySelector<HTMLElement>("[data-participant-search-wrap]");
  const participantSearch = participantsDialog?.querySelector<HTMLInputElement>("[data-participant-search]");
  const participantsError = participantsDialog?.querySelector<HTMLElement>("[data-participants-error]");
  const bracketDialog = root.querySelector<HTMLDialogElement>(".qualifier-bracket-dialog");
  const bracketContent = bracketDialog?.querySelector<HTMLElement>("[data-qualifier-bracket-content]");
  let bracketRefreshTimer: number | null = null;
  let participants = [...initialParticipantPage.participants];
  let participantTotal = initialParticipantPage.total;
  let participantOffset = initialParticipantPage.nextOffset;
  let participantsHaveMore = initialParticipantPage.hasMore;
  let participantQuery = "";
  let participantSearchTimer = 0;
  let participantRequestSequence = 0;
  let participantPageLoading = false;

  const closeDialog = () => dialog?.close();
  dialog?.querySelector("[data-close-tournament-entry]")?.addEventListener("click", closeDialog);
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog();
  });
  dialog?.querySelector<HTMLButtonElement>("[data-purchase-tournament-ios]")?.addEventListener("click", async (event) => {
    if (
      payment.kind !== "app-store" ||
      !payment.config.appAccountToken ||
      !payment.product ||
      !tournament ||
      !error
    ) return;
    const button = event.currentTarget as HTMLButtonElement;
    const originalLabel = button.textContent || "Inscribirme con App Store";
    button.disabled = true;
    button.textContent = "Confirmando con App Store…";
    error.textContent = "";
    try {
      const result = await purchaseNativeStoreProduct(
        payment.product.id,
        payment.config.appAccountToken,
      );
      if (result.state === "cancelled") {
        button.disabled = false;
        button.textContent = originalLabel;
        toast("La inscripción fue cancelada; no se realizó ningún cargo.", "error");
        return;
      }
      if (result.state === "pending") {
        error.textContent = "La compra espera aprobación de App Store. La inscripción se confirmará automáticamente.";
        button.textContent = "Pendiente de aprobación";
        return;
      }
      if (!result.transaction) return;
      try {
        await confirmAndFinishNativeTransaction(result.transaction);
      } catch (confirmationError) {
        error.textContent = "Apple confirmó el cobro, pero la inscripción aún está pendiente. La reintentaremos automáticamente; no vuelvas a comprar.";
        button.textContent = "Confirmación pendiente";
        console.warn("La inscripción de App Store quedó pendiente.", confirmationError);
        return;
      }
      dialog?.close();
      toast("¡Inscripción confirmada! Ya representas a tu país.");
      await renderTournaments();
    } catch (purchaseError) {
      error.textContent = errorMessage(purchaseError);
      button.disabled = false;
      button.textContent = originalLabel;
    }
  });
  root.querySelector("[data-open-tournament-entry]")?.addEventListener("click", async () => {
    if (!dialog || !container || !error || !tournament) return;
    dialog.showModal();
    if (payment.kind === "app-store") return;
    if (!payment.config.enabled || !payment.config.clientId || paymentButtons || initializing) return;
    initializing = true;
    error.textContent = "";
    try {
      const paypal = await loadPayPalSdk(
        payment.config.clientId,
        payment.config.currency,
      );
      if (!dialog.isConnected) return;
      container.innerHTML = "";
      paymentButtons = paypal.Buttons({
        style: { layout: "vertical", color: "gold", shape: "rect", label: "paypal", height: 45 },
        createOrder: async () => (await api.createTournamentEntryOrder(tournament.id)).id,
        onApprove: async ({ orderID }) => {
          const result = await api.captureTournamentEntryOrder(tournament.id, orderID);
          if (result.status !== "COMPLETED") {
            throw new Error("PayPal no pudo confirmar la inscripción.");
          }
          dialog.close();
          toast("¡Inscripción confirmada! Ya representas a tu país.");
          await renderTournaments();
        },
        onCancel: () => toast("La inscripción fue cancelada; no se realizó ningún cargo.", "error"),
        onError: (paymentError) => {
          error.textContent = errorMessage(paymentError);
        },
      });
      await paymentButtons.render(container);
    } catch (sdkError) {
      error.textContent = errorMessage(sdkError);
      container.innerHTML = `<div class="donation-sdk-error"><b>No pudimos abrir PayPal.</b><small>Revisa tu conexión e inténtalo nuevamente.</small></div>`;
    } finally {
      initializing = false;
    }
  });
  const showParticipantList = () => {
    if (!participantsGrid) return;
    participantsGrid.innerHTML = `${tournamentParticipantCards(participants)}${communityListMoreMarkup("tournament-participants", participantsHaveMore)}`;
    if (participantsTitle) participantsTitle.textContent = "Jugadores inscritos";
    if (participantsSubtitle) {
      participantsSubtitle.textContent = participantQuery
        ? `${participantTotal} ${participantTotal === 1 ? "resultado" : "resultados"}`
        : `${participantTotal} ${participantTotal === 1 ? "perfil confirmado" : "perfiles confirmados"}`;
    }
    if (participantSearchWrap) participantSearchWrap.hidden = false;
    if (participantsError) participantsError.textContent = "";
    participantsGrid.querySelectorAll<HTMLButtonElement>("[data-tournament-profile]").forEach((button) => {
      button.addEventListener("click", () => void showPlayerProfile(button.dataset.tournamentProfile || ""));
    });
    participantsGrid.querySelector<HTMLButtonElement>("[data-load-more-tournament-participants]")
      ?.addEventListener("click", () => void loadParticipantPage(false));
  };
  const loadParticipantPage = async (reset: boolean) => {
    if (!tournament || (!reset && (participantPageLoading || !participantsHaveMore))) return;
    participantPageLoading = true;
    const sequence = reset ? ++participantRequestSequence : participantRequestSequence;
    const requestedQuery = participantQuery;
    const button = participantsGrid?.querySelector<HTMLButtonElement>("[data-load-more-tournament-participants]");
    if (button) {
      button.disabled = true;
      button.textContent = "Cargando…";
    }
    if (reset && participantsGrid) {
      participantsGrid.innerHTML = `<div class="tournament-profile-loading"><span class="loader"></span><p>Buscando jugadores…</p></div>`;
    }
    try {
      const page = await api.tournamentParticipants(
        tournament.id,
        reset ? 0 : participantOffset,
        requestedQuery,
      );
      if (sequence !== participantRequestSequence || requestedQuery !== participantQuery) return;
      if (reset) {
        participants = page.participants;
      } else {
        const knownIds = new Set(participants.map((participant) => participant.id));
        participants.push(...page.participants.filter((participant) => !knownIds.has(participant.id)));
      }
      participantTotal = page.total;
      participantOffset = page.nextOffset;
      participantsHaveMore = page.hasMore;
      showParticipantList();
    } catch (loadError) {
      if (sequence !== participantRequestSequence || requestedQuery !== participantQuery) return;
      if (reset && participantsGrid) {
        participantsGrid.innerHTML = `<div class="tournament-participants-empty"><b>No pudimos cargar los jugadores</b><p>${escapeHtml(errorMessage(loadError))}</p></div>`;
      } else if (button) {
        button.disabled = false;
        button.textContent = `Ver ${LIST_PAGE_SIZE} más`;
      }
      if (participantsError) participantsError.textContent = errorMessage(loadError);
    } finally {
      if (sequence === participantRequestSequence) participantPageLoading = false;
    }
  };
  const showPlayerProfile = async (username: string, fromWorldPodium = false) => {
    if (!participantsGrid || !username) return;
    participantRequestSequence += 1;
    participantPageLoading = false;
    participantsGrid.innerHTML = `<div class="tournament-profile-loading"><span class="loader"></span><p>Cargando perfil…</p></div>`;
    if (participantsTitle) participantsTitle.textContent = "Perfil del jugador";
    if (participantsSubtitle) participantsSubtitle.textContent = `@${username}`;
    if (participantSearchWrap) participantSearchWrap.hidden = true;
    if (participantsError) participantsError.textContent = "";
    try {
      const response = await api.playerStatistics(username);
      participantsGrid.innerHTML = tournamentPlayerProfileMarkup(
        response,
        fromWorldPodium ? "Volver al Campeonato Mundial" : "Todos los inscritos",
      );
      participantsGrid.querySelector("[data-back-participants]")?.addEventListener("click", () => {
        if (fromWorldPodium) participantsDialog?.close();
        else showParticipantList();
      });
      participantsGrid.querySelector<HTMLButtonElement>("[data-follow-tournament-player]")?.addEventListener("click", async (event) => {
        const button = event.currentTarget as HTMLButtonElement;
        button.disabled = true;
        try {
          await api.follow(button.dataset.followTournamentPlayer || username);
          button.className = "button button--quiet button--small";
          button.textContent = "✓ En tus amigos";
          toast(`@${username} fue agregado a tus amigos.`);
        } catch (error) {
          button.disabled = false;
          if (participantsError) participantsError.textContent = errorMessage(error);
        }
      });
    } catch (error) {
      participantsGrid.innerHTML = `<div class="tournament-participants-empty"><b>No pudimos cargar el perfil</b><p>${escapeHtml(errorMessage(error))}</p><button type="button" data-back-participants>${fromWorldPodium ? "Volver al Campeonato Mundial" : "Volver a los inscritos"}</button></div>`;
      participantsGrid.querySelector("[data-back-participants]")?.addEventListener("click", () => {
        if (fromWorldPodium) participantsDialog?.close();
        else showParticipantList();
      });
    }
  };
  root.querySelector("[data-open-tournament-participants]")?.addEventListener("click", () => {
    if (!participantsDialog) return;
    participantsDialog.showModal();
    if (participantSearch && participantQuery) {
      participantSearch.value = "";
      participantQuery = "";
      void loadParticipantPage(true);
    } else {
      showParticipantList();
    }
  });
  participantsDialog?.querySelector("[data-close-tournament-participants]")?.addEventListener("click", () => participantsDialog.close());
  participantsDialog?.addEventListener("click", (event) => {
    if (event.target === participantsDialog) participantsDialog.close();
  });
  participantSearch?.addEventListener("input", () => {
    if (participantSearchTimer) window.clearTimeout(participantSearchTimer);
    participantQuery = participantSearch.value.trim();
    participantSearchTimer = window.setTimeout(() => void loadParticipantPage(true), 320);
  });
  const stopBracketRefresh = () => {
    if (bracketRefreshTimer !== null) window.clearInterval(bracketRefreshTimer);
    bracketRefreshTimer = null;
  };
  const loadQualifierBracket = async (
    countryCode = currentUser?.countryCode || "DO",
    silent = false,
  ) => {
    if (!tournament || !bracketContent) return;
    if (!silent) {
      bracketContent.innerHTML = `<div class="tournament-profile-loading"><span class="loader"></span><p>Preparando el cuadro…</p></div>`;
    }
    try {
      const bracket = await api.qualifierBracket(tournament.id, countryCode);
      if (!bracketContent.isConnected || !bracketDialog?.open) return;
      const previousScroll = silent ? bracketContent.scrollTop : 0;
      bracketContent.innerHTML = qualifierBracketMarkup(bracket);
      if (silent) bracketContent.scrollTop = previousScroll;
      bracketContent.querySelector<HTMLSelectElement>("[data-bracket-country]")?.addEventListener("change", (event) => {
        void loadQualifierBracket((event.currentTarget as HTMLSelectElement).value);
      });
    } catch (bracketError) {
      if (!silent) {
        bracketContent.innerHTML = `<div class="qualifier-bracket-empty"><span>!</span><b>No pudimos cargar el cuadro</b><p>${escapeHtml(errorMessage(bracketError))}</p><button class="button button--outline button--small" type="button" data-retry-bracket>Intentar de nuevo</button></div>`;
        bracketContent.querySelector("[data-retry-bracket]")?.addEventListener("click", () => void loadQualifierBracket(countryCode));
      }
    }
  };
  root.querySelector("[data-open-qualifier-bracket]")?.addEventListener("click", () => {
    if (!bracketDialog || !tournament) return;
    bracketDialog.showModal();
    void loadQualifierBracket();
    stopBracketRefresh();
    bracketRefreshTimer = window.setInterval(() => {
      const selectedCountry = bracketContent?.querySelector<HTMLSelectElement>("[data-bracket-country]")?.value
        || currentUser?.countryCode
        || "DO";
      void loadQualifierBracket(selectedCountry, true);
    }, 30_000);
  });
  const closeBracket = () => {
    stopBracketRefresh();
    bracketDialog?.close();
  };
  bracketDialog?.querySelector("[data-close-qualifier-bracket]")?.addEventListener("click", closeBracket);
  bracketDialog?.addEventListener("click", (event) => {
    if (event.target === bracketDialog) closeBracket();
  });
  pageCleanup = () => {
    stopBracketRefresh();
    if (participantSearchTimer) window.clearTimeout(participantSearchTimer);
    paymentButtons?.close?.();
    if (dialog?.open) dialog.close();
    if (participantsDialog?.open) participantsDialog.close();
    if (bracketDialog?.open) bracketDialog.close();
  };
}

function invitationUrl(token: string) {
  const url = new URL(PUBLIC_APP_URL);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/`;
  url.search = "";
  url.hash = "";
  url.searchParams.set("invitacion", token);
  return url.toString();
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const temporary = document.createElement("textarea");
  temporary.value = value;
  temporary.style.position = "fixed";
  temporary.style.opacity = "0";
  document.body.append(temporary);
  temporary.select();
  document.execCommand("copy");
  temporary.remove();
}

function stopLinkInvitationPolling() {
  if (linkInvitationTimer) window.clearInterval(linkInvitationTimer);
  linkInvitationTimer = null;
}

function stopOutgoingChallengePolling() {
  if (outgoingChallengeTimer) window.clearInterval(outgoingChallengeTimer);
  outgoingChallengeTimer = null;
}

function removeOutgoingChallengeDialog() {
  stopOutgoingChallengePolling();
  if (outgoingChallengeDialog?.open) outgoingChallengeDialog.close();
  outgoingChallengeDialog?.remove();
  outgoingChallengeDialog = null;
}

function openProfileChallenge(
  player: Pick<User, "name" | "username" | "avatarUrl" | "worldTitle">,
) {
  if (outgoingChallengeDialog) {
    outgoingChallengeDialog.focus();
    return;
  }

  let timeControl = selectedTime;
  let invitation: DirectInvitation | null = null;
  let requestRunning = false;
  const dialog = document.createElement("dialog");
  dialog.className = "direct-challenge-dialog";
  dialog.setAttribute("aria-labelledby", "direct-challenge-title");
  dialog.innerHTML = `
    <button class="dialog-close" type="button" data-close-direct-challenge aria-label="Cerrar">×</button>
    <span class="invite-seal">${icon("play")}</span>
    <span class="section-kicker">DESAFÍO DIRECTO · 10×10</span>
    <h2 id="direct-challenge-title">Desafiar a @${escapeHtml(player.username)}</h2>
    <p>Elige el tiempo de cada jugador. La invitación estará disponible durante 15 minutos.</p>
    <div class="direct-challenge-player">
      ${avatarMarkup(player, "avatar avatar--invite-preview")}
      <span><small>TU RIVAL</small><span class="player-name-with-title"><b>${escapeHtml(player.name)}</b>${worldTrophyMarkup(player)}</span><em>@${escapeHtml(player.username)}</em></span>
    </div>
    <div class="direct-challenge-times" role="radiogroup" aria-label="Tiempo por jugador">
      ${TIME_CONTROLS.map((minutes) => `<button class="${minutes === timeControl ? "is-selected" : ""}" type="button" role="radio" aria-checked="${minutes === timeControl}" data-direct-challenge-time="${minutes}"><b>${minutes}</b><small>minutos</small></button>`).join("")}
    </div>
    <div class="direct-challenge-status" data-direct-challenge-status aria-live="polite"></div>
    <div class="direct-challenge-actions">
      <button class="button button--quiet" type="button" data-close-direct-challenge>Cancelar</button>
      <button class="button button--primary" type="button" data-send-direct-challenge>${icon("play")} Enviar desafío</button>
    </div>`;

  const status = dialog.querySelector<HTMLElement>("[data-direct-challenge-status]");
  const sendButton = dialog.querySelector<HTMLButtonElement>("[data-send-direct-challenge]");
  const closeButtons = dialog.querySelectorAll<HTMLButtonElement>("[data-close-direct-challenge]");

  const close = async (cancelPending: boolean) => {
    if (requestRunning) return;
    const pendingId = invitation?.status === "pending" ? invitation.id : null;
    removeOutgoingChallengeDialog();
    if (cancelPending && pendingId) {
      await api.cancelInvitation(pendingId).catch(() => {});
    }
  };

  dialog.querySelectorAll<HTMLButtonElement>("[data-direct-challenge-time]").forEach((button) => {
    button.addEventListener("click", () => {
      timeControl = Number(button.dataset.directChallengeTime) as TimeControl;
      dialog.querySelectorAll<HTMLButtonElement>("[data-direct-challenge-time]").forEach((option) => {
        const isSelected = option === button;
        option.classList.toggle("is-selected", isSelected);
        option.setAttribute("aria-checked", String(isSelected));
      });
    });
  });

  const checkStatus = async () => {
    if (!invitation || requestRunning) return;
    requestRunning = true;
    try {
      const result = await api.invitationStatus(invitation.id);
      invitation = result.invitation;
      if (result.invitation.status === "accepted" && result.game) {
        removeOutgoingChallengeDialog();
        toast(`@${player.username} aceptó tu desafío.`);
        navigate(`/partida/${result.game.id}`);
        return;
      }
      if (result.invitation.status !== "pending") {
        stopOutgoingChallengePolling();
        if (status) {
          status.className = "direct-challenge-status is-error";
          status.textContent = result.invitation.status === "declined"
            ? `@${player.username} rechazó el desafío.`
            : "Este desafío ya no está disponible.";
        }
        if (sendButton) {
          sendButton.disabled = false;
          sendButton.innerHTML = `${icon("play")} Enviar otro desafío`;
        }
        dialog.querySelectorAll<HTMLButtonElement>("[data-direct-challenge-time]").forEach((option) => {
          option.disabled = false;
        });
        invitation = null;
      }
    } catch (error) {
      if (status) {
        status.className = "direct-challenge-status is-error";
        status.textContent = errorMessage(error);
      }
    } finally {
      requestRunning = false;
    }
  };

  sendButton?.addEventListener("click", async () => {
    if (requestRunning) return;
    requestRunning = true;
    sendButton.disabled = true;
    sendButton.innerHTML = `${icon("play")} Enviando…`;
    if (status) {
      status.className = "direct-challenge-status";
      status.textContent = "";
    }
    try {
      const result = await api.createInvitation(player.username, timeControl);
      invitation = result.invitation;
      selectedTime = timeControl;
      dialog.querySelectorAll<HTMLButtonElement>("[data-direct-challenge-time]").forEach((option) => {
        option.disabled = true;
      });
      if (status) {
        status.className = "direct-challenge-status is-waiting";
        status.innerHTML = `<i class="status-dot"></i><span><b>Desafío enviado</b><small>Esperando la respuesta de @${escapeHtml(player.username)}…</small></span>`;
      }
      sendButton.innerHTML = "Esperando respuesta…";
      closeButtons.forEach((button) => {
        button.textContent = button.classList.contains("dialog-close") ? "×" : "Cancelar desafío";
      });
      stopOutgoingChallengePolling();
      outgoingChallengeTimer = window.setInterval(() => void checkStatus(), 1600);
    } catch (error) {
      sendButton.disabled = false;
      sendButton.innerHTML = `${icon("play")} Enviar desafío`;
      if (status) {
        status.className = "direct-challenge-status is-error";
        status.textContent = errorMessage(error);
      }
    } finally {
      requestRunning = false;
    }
  });

  closeButtons.forEach((button) => {
    button.addEventListener("click", () => void close(true));
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    void close(true);
  });
  document.body.append(dialog);
  outgoingChallengeDialog = dialog;
  dialog.showModal();
}

function closeIncomingChallengeDialog() {
  if (incomingChallengeDialog?.open) incomingChallengeDialog.close();
  incomingChallengeDialog?.remove();
  incomingChallengeDialog = null;
  incomingChallengeId = null;
}

function showIncomingChallenge(invitation: DirectInvitation) {
  if (incomingChallengeId === invitation.id && incomingChallengeDialog) return;
  closeIncomingChallengeDialog();
  incomingChallengeId = invitation.id;
  const challenger = invitation.opponent;
  const dialog = document.createElement("dialog");
  dialog.className = "direct-challenge-dialog incoming-challenge-dialog";
  dialog.setAttribute("aria-labelledby", "incoming-challenge-title");
  dialog.innerHTML = `
    <span class="invite-seal">${icon("crown")}</span>
    <span class="section-kicker">TE HAN DESAFIADO · 10×10</span>
    <h2 id="incoming-challenge-title">@${escapeHtml(challenger.username)} te desafía</h2>
    <p>¿Aceptas enfrentarte a ${escapeHtml(challenger.name)} en una partida de ${invitation.timeControlMinutes} minutos por jugador?</p>
    <div class="direct-challenge-player">
      ${avatarMarkup(challenger, "avatar avatar--invite-preview")}
      <span><small>QUIEN TE DESAFÍA</small><span class="player-name-with-title"><b>${escapeHtml(challenger.name)}</b>${worldTrophyMarkup(challenger)}</span><em>@${escapeHtml(challenger.username)} · ${challenger.rating.toLocaleString(localeCode())} Elo</em></span>
    </div>
    <div class="incoming-challenge-detail"><span><small>Modalidad</small><b>10 × 10</b></span><span><small>Reloj</small><b>${invitation.timeControlMinutes} min</b></span></div>
    <div class="direct-challenge-status" data-incoming-challenge-status aria-live="polite"></div>
    <div class="direct-challenge-actions">
      <button class="button button--quiet" type="button" data-decline-direct-challenge>Rechazar</button>
      <button class="button button--primary" type="button" data-accept-direct-challenge>${icon("play")} Aceptar y jugar</button>
    </div>`;
  const acceptButton = dialog.querySelector<HTMLButtonElement>("[data-accept-direct-challenge]");
  const declineButton = dialog.querySelector<HTMLButtonElement>("[data-decline-direct-challenge]");
  const status = dialog.querySelector<HTMLElement>("[data-incoming-challenge-status]");
  let responding = false;

  const setResponding = (value: boolean) => {
    responding = value;
    if (acceptButton) acceptButton.disabled = value;
    if (declineButton) declineButton.disabled = value;
  };
  const showError = (error: unknown) => {
    if (status) {
      status.className = "direct-challenge-status is-error";
      status.textContent = errorMessage(error);
    }
  };
  const decline = async () => {
    if (responding) return;
    setResponding(true);
    try {
      await api.declineInvitation(invitation.id);
      closeIncomingChallengeDialog();
      toast(`Rechazaste el desafío de @${challenger.username}.`);
    } catch (error) {
      setResponding(false);
      showError(error);
    }
  };
  acceptButton?.addEventListener("click", async () => {
    if (responding) return;
    setResponding(true);
    acceptButton.innerHTML = `${icon("play")} Preparando partida…`;
    try {
      const result = await api.acceptInvitation(invitation.id);
      closeIncomingChallengeDialog();
      navigate(`/partida/${result.game.id}`);
    } catch (error) {
      setResponding(false);
      acceptButton.innerHTML = `${icon("play")} Aceptar y jugar`;
      showError(error);
    }
  });
  declineButton?.addEventListener("click", () => void decline());
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    void decline();
  });
  document.body.append(dialog);
  incomingChallengeDialog = dialog;
  dialog.showModal();
}

async function checkIncomingChallenges() {
  if (
    !currentUser ||
    incomingChallengeCheckRunning ||
    /^\/partida\/\d+$/.test(route())
  ) return;
  incomingChallengeCheckRunning = true;
  try {
    const invitation = (await api.invitations()).invitations.find(
      (item) => item.status === "pending" && item.direction === "received",
    );
    if (invitation) showIncomingChallenge(invitation);
    else if (incomingChallengeDialog) closeIncomingChallengeDialog();
  } catch {
    // El evento de tiempo real o la próxima carga volverán a intentarlo.
  } finally {
    incomingChallengeCheckRunning = false;
  }
}

async function createFriendChallenge() {
  const trigger = root.querySelector<HTMLButtonElement>("[data-challenge-friend]");
  if (trigger) {
    trigger.disabled = true;
    trigger.innerHTML = `${icon("link")} Generando enlace…`;
  }
  try {
    const { invitation } = await api.createLinkInvitation(selectedTime);
    if (!invitation.token) throw new Error("El servidor no devolvió el enlace de invitación.");
    openFriendChallenge(invitation);
  } catch (error) {
    toast(errorMessage(error), "error");
  } finally {
    if (trigger) {
      trigger.disabled = false;
      trigger.innerHTML = `${icon("link")} Desafiar a un amigo`;
    }
  }
}

function openFriendChallenge(invitation: LinkInvitation) {
  const token = invitation.token;
  const modal = root.querySelector<HTMLElement>(".friend-invite-modal");
  const backdrop = root.querySelector<HTMLElement>("[data-match-backdrop]");
  const input = modal?.querySelector<HTMLInputElement>("[data-invite-url]");
  const time = modal?.querySelector<HTMLElement>("[data-invite-time]");
  const preview = modal?.querySelector<HTMLElement>("[data-invite-share-preview]");
  if (!token || !modal || !input) return;
  const url = invitationUrl(token);
  const challengeText = friendChallengeText(invitation);
  const challengeMessage = friendChallengeMessage(invitation, url);
  input.value = url;
  if (time) time.textContent = `${invitation.timeControlMinutes} minutos`;
  if (preview) {
    preview.innerHTML = `${avatarMarkup(invitation.sender, "avatar avatar--invite-preview")}<span><small>MENSAJE PARA TU AMIGO</small><b>@${escapeHtml(invitation.sender.username)} te desafía</b><em>¿Tienes lo necesario para arrebatarle la corona?</em></span>`;
  }
  modal.classList.add("is-visible");
  modal.setAttribute("aria-hidden", "false");
  backdrop?.classList.add("is-visible");

  const showCopied = async () => {
    try {
      await copyText(url);
      toast("Enlace copiado. Envíalo a tu amigo.");
    } catch {
      input.focus();
      input.select();
      toast("Selecciona el enlace y cópialo manualmente.", "error");
    }
  };
  modal.querySelector("[data-copy-invite]")?.addEventListener("click", () => void showCopied());
  modal.querySelector("[data-copy-invite-text]")?.addEventListener("click", async () => {
    try {
      await copyText(challengeMessage);
      toast("Mensaje desafiante copiado. Envíalo a tu amigo.");
    } catch {
      input.focus();
      input.select();
      toast("No pudimos copiar el mensaje.", "error");
    }
  });
  modal.querySelector("[data-share-invite]")?.addEventListener("click", async () => {
    if (!navigator.share) return showCopied();
    try {
      await navigator.share({
        title: currentLanguage() === "en"
          ? `@${invitation.sender.username} challenges you for the crown`
          : `@${invitation.sender.username} te reta por la corona`,
        text: challengeText,
        url,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      toast("No pudimos compartir el enlace.", "error");
    }
  });

  const cancel = async () => {
    stopLinkInvitationPolling();
    modal.classList.remove("is-visible");
    modal.setAttribute("aria-hidden", "true");
    backdrop?.classList.remove("is-visible");
    await api.cancelLinkInvitation(token).catch(() => {});
  };
  modal.querySelectorAll("[data-cancel-friend]").forEach((button) => {
    button.addEventListener("click", () => void cancel());
  });

  let requestRunning = false;
  const checkStatus = async () => {
    if (requestRunning) return;
    requestRunning = true;
    try {
      const result = await api.linkInvitationStatus(token);
      if (result.invitation.status === "accepted" && result.game) {
        stopLinkInvitationPolling();
        modal.classList.remove("is-visible");
        backdrop?.classList.remove("is-visible");
        toast("¡Tu amigo aceptó el desafío!");
        navigate(`/partida/${result.game.id}`);
      } else if (result.invitation.status !== "pending") {
        stopLinkInvitationPolling();
        const error = modal.querySelector<HTMLElement>(".friend-invite-error");
        if (error) error.textContent = result.invitation.status === "expired"
          ? "El enlace venció. Crea uno nuevo para volver a invitar."
          : "Esta invitación ya no está disponible.";
      }
    } catch (error) {
      const feedback = modal.querySelector<HTMLElement>(".friend-invite-error");
      if (feedback) feedback.textContent = errorMessage(error);
    } finally {
      requestRunning = false;
    }
  };
  stopLinkInvitationPolling();
  linkInvitationTimer = window.setInterval(() => void checkStatus(), 1600);
  void checkStatus();
}

async function startMatchmaking() {
  const modal = root.querySelector<HTMLElement>(".matchmaking-modal");
  const backdrop = root.querySelector<HTMLElement>("[data-match-backdrop]");
  modal?.setAttribute("aria-hidden", "false");
  modal?.classList.add("is-visible");
  backdrop?.classList.add("is-visible");
  matchmakingStartedAt = Date.now();
  updateSearchClock();
  matchmakingTimer = window.setInterval(() => {
    updateSearchClock();
    void checkMatchmaking();
  }, 1500);
  try {
    handleMatchmaking(await api.joinMatchmaking(
      selectedTime,
      pieceColorPreferences().own,
    ));
  } catch (error) {
    await stopMatchmaking(false);
    toast(errorMessage(error), "error");
  }
}

function updateSearchClock() {
  const elapsed = Math.floor((Date.now() - matchmakingStartedAt) / 1000);
  const element = root.querySelector<HTMLElement>(".search-time");
  if (element) element.textContent = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
}

async function checkMatchmaking() {
  try {
    handleMatchmaking(await api.matchmakingStatus(
      selectedTime,
      pieceColorPreferences().own,
    ));
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) await stopMatchmaking(false);
  }
}

function handleMatchmaking(result: MatchmakingResult) {
  if (result.status === "matched") {
    void stopMatchmaking(false);
    navigate(`/partida/${result.game.id}`);
    return;
  }
  if (result.status === "direct_pending") {
    void stopMatchmaking(false);
    toast("Tienes una invitación pendiente.", "error");
    return;
  }
  const detail = root.querySelector<HTMLElement>(".search-detail");
  if (detail) detail.textContent = `Rango ±${result.searchRange} · posición ${result.queuePosition}`;
}

async function stopMatchmaking(leave: boolean) {
  if (matchmakingTimer) window.clearInterval(matchmakingTimer);
  matchmakingTimer = null;
  root.querySelector(".matchmaking-modal")?.classList.remove("is-visible");
  root.querySelector("[data-match-backdrop]")?.classList.remove("is-visible");
  if (leave) {
    try { await api.leaveMatchmaking(); } catch { /* La cola expira en el servidor. */ }
  }
}

async function renderLeaderboard() {
  root.innerHTML = appLayout(loadingMarkup("Ordenando la clasificación…"), "ranking");
  bindNavigation();
  await loadLeaderboard("DO");
}

async function loadLeaderboard(scope: "DO" | "WORLD") {
  try {
    const response = await api.leaderboard(scope);
    const players = [...response.players];
    let nextOffset = response.nextOffset;
    let hasMore = response.hasMore;
    let loadingMore = false;
    root.innerHTML = appLayout(`
      <section class="page-heading"><div><span class="eyebrow"><i></i>Elo Damas oficial</span><h1>Clasificación</h1><p>Los jugadores que están marcando el ritmo en la modalidad 10×10.</p></div><span class="mode-pill mode-pill--large">10 × 10</span></section>
      ${eloTierScaleMarkup()}
      <section class="panel leaderboard-panel">
        <div class="leaderboard-toolbar">
          <div class="scope-toggle"><button class="${scope === "DO" ? "is-active" : ""}" data-scope="DO">${flag("DO")} Nacional</button><button class="${scope === "WORLD" ? "is-active" : ""}" data-scope="WORLD">🌐 Mundial</button></div>
          <span>${response.totalPlayers} jugadores clasificados</span>
        </div>
        <div data-leaderboard-results>${leaderboardTable(players, false)}</div>
        <div data-leaderboard-more></div>
      </section>`, "ranking");
    bindNavigation();
    root.querySelectorAll<HTMLButtonElement>("[data-scope]").forEach((button) => {
      button.addEventListener("click", () => void loadLeaderboard(button.dataset.scope as "DO" | "WORLD"));
    });
    const results = root.querySelector<HTMLElement>("[data-leaderboard-results]");
    const more = root.querySelector<HTMLElement>("[data-leaderboard-more]");
    const renderMore = () => {
      if (!more) return;
      more.innerHTML = hasMore
        ? `<div class="profile-following-more"><button class="button button--quiet button--small" type="button" data-load-more-leaderboard>Ver ${LIST_PAGE_SIZE} más</button><small>${players.length} de ${response.totalPlayers} jugadores mostrados.</small></div>`
        : "";
      more.querySelector<HTMLButtonElement>("[data-load-more-leaderboard]")
        ?.addEventListener("click", async (event) => {
          if (loadingMore) return;
          loadingMore = true;
          const button = event.currentTarget as HTMLButtonElement;
          button.disabled = true;
          button.textContent = "Cargando…";
          try {
            const page = await api.leaderboard(scope, nextOffset);
            if (route() !== "/clasificacion") return;
            players.push(...page.players);
            nextOffset = page.nextOffset;
            hasMore = page.hasMore;
            if (results) results.innerHTML = leaderboardTable(players, false);
            renderMore();
          } catch (error) {
            button.disabled = false;
            button.textContent = `Ver ${LIST_PAGE_SIZE} más`;
            toast(errorMessage(error), "error");
          } finally {
            loadingMore = false;
          }
        });
    };
    renderMore();
  } catch (error) {
    root.innerHTML = appLayout(errorState(errorMessage(error)), "ranking");
    bindNavigation();
    bindRetry(() => loadLeaderboard(scope));
  }
}

function eloTierScaleMarkup() {
  const viewerTier = currentRating
    ? currentRating.tier ?? eloTier(currentRating.rating)
    : null;
  return `<section class="panel elo-tier-panel" aria-labelledby="elo-tier-title">
    <div class="elo-tier-heading"><div><span class="section-kicker">PROGRESIÓN OFICIAL</span><h2 id="elo-tier-title">Rangos de Elo Damas</h2></div><p>Tu título cambia automáticamente cuando tu Elo entra en un nuevo nivel.</p></div>
    <div class="elo-tier-scale">
      ${ELO_TIERS.map((tier) => `<span class="${viewerTier === tier.label ? "is-current" : ""}"><small>${eloTierRange(tier)}</small><b>${escapeHtml(tier.label)}</b>${viewerTier === tier.label ? "<em>Tu rango</em>" : ""}</span>`).join("")}
    </div>
  </section>`;
}

function leaderboardTable(players: LeaderboardPlayer[], compact: boolean) {
  if (!players.length) {
    return `<div class="empty-state"><span>${icon("ranking")}</span><h3>La clasificación está lista para estrenarse</h3><p>Completa una partida clasificada y conviértete en la primera referencia.</p></div>`;
  }
  return `<div class="ranking-table ${compact ? "is-compact" : ""}" role="table" aria-label="Clasificación Elo Damas">
    <div class="ranking-head" role="row"><span>Pos.</span><span>Jugador</span><span>Partidas</span><span>V-D-T</span><span>Elo Damas</span></div>
    ${players.map((player) => `<div class="ranking-row ${currentUser?.id === player.id ? "is-me" : ""}" role="row">
      <span class="rank-position ${player.position <= 3 ? "is-top" : ""}">${player.position <= 3 ? ["🥇", "🥈", "🥉"][player.position - 1] : `#${player.position}`}</span>
      ${playerProfileButton(player, `${avatarMarkup(player, "avatar avatar--table")}<span><span class="player-name-with-title"><b>${escapeHtml(player.name)}</b>${worldTrophyMarkup(player, "world-trophy--ranking")}</span><small>${flag(player.countryCode)} @${escapeHtml(player.username)}</small>${worldTitleRecognitionMarkup(player, "world-title-recognition--ranking")}</span>`, "rank-player")}
      <span>${player.gamesPlayed}</span><span>${player.wins}-${player.losses}-${player.draws}</span><strong>${player.rating.toLocaleString(localeCode())}<small>${escapeHtml(player.tier ?? eloTier(player.rating))}</small></strong>
    </div>`).join("")}
  </div>`;
}

function errorState(message: string) {
  return `<div class="error-state"><span>!</span><h2>No pudimos cargar esta mesa</h2><p>${escapeHtml(message)}</p><button class="button button--primary" data-retry>Intentar de nuevo</button></div>`;
}

function bindRetry(action: () => void) {
  root.querySelector("[data-retry]")?.addEventListener("click", action);
}

function clearSharedInvitation() {
  const url = new URL(window.location.href);
  url.searchParams.delete("invitacion");
  window.history.replaceState({}, "", url);
}

async function renderSharedInvitation(token: string) {
  const loading = loadingMarkup("Abriendo el desafío…");
  root.innerHTML = currentUser
    ? appLayout(loading)
    : `<div class="landing">${publicHeader()}<main>${loading}</main>${authDialogMarkup()}</div>`;
  bindNavigation();
  if (!currentUser) bindAuthDialog();
  try {
    const { invitation } = await api.linkInvitation(token);
    const ownInvitation = currentUser?.id === invitation.sender.id;
    const available = invitation.status === "pending";
    const card = `
      <section class="shared-invitation-page">
        <div class="shared-invitation-card">
          <span class="invite-seal invite-seal--large invite-brand-mark"><img src="/brand/icon-192.png?v=piece-1" alt="" /></span>
          <span class="section-kicker">INVITACIÓN PRIVADA</span>
          <h1>${ownInvitation ? "Este es tu desafío" : `@${escapeHtml(invitation.sender.username)} te espera`}</h1>
          <p>${ownInvitation ? "Comparte el enlace original y espera a que tu amigo lo acepte." : "¿Puedes arrebatarle la corona? Acepta el desafío y demuestra tu nivel en el tablero."}</p>
          ${playerProfileButton(invitation.sender, `
            ${avatarMarkup(invitation.sender, "avatar avatar--challenger")}
            <span><small>QUIEN TE DESAFÍA</small><span class="player-name-with-title"><b>${escapeHtml(invitation.sender.name)}</b>${worldTrophyMarkup(invitation.sender)}</span><em>@${escapeHtml(invitation.sender.username)}</em>${worldTitleRecognitionMarkup(invitation.sender, "world-title-recognition--compact")}</span>
            <strong>${invitation.sender.rating}<small>Elo Damas</small></strong>
          `, "challenger-card")}
          <div class="challenge-details"><span><small>Modalidad</small><b>10 × 10</b></span><span><small>Reloj por jugador</small><b>${invitation.timeControlMinutes} minutos</b></span><span><small>Disponibilidad</small><b>${available ? "Una persona" : "No disponible"}</b></span></div>
          ${!available ? `<p class="invitation-unavailable">Esta invitación ya no está disponible.</p>` : ""}
          <p class="shared-invite-error" aria-live="polite"></p>
          <div class="shared-invite-actions">
            ${!currentUser ? `<button class="button button--primary" data-open-auth="login">Entrar para aceptar</button><button class="button button--outline" data-open-auth="register">Crear cuenta</button>` : available && !ownInvitation ? `<button class="button button--primary button--wide" data-accept-shared>${icon("play")} Aceptar y jugar</button>` : ""}
            <button class="text-button" data-dismiss-shared>Volver al inicio</button>
          </div>
          <small class="one-person-note">Solo una persona puede aceptar este enlace.</small>
        </div>
      </section>`;
    root.innerHTML = currentUser
      ? appLayout(card)
      : `<div class="landing">${publicHeader()}<main>${card}</main>${authDialogMarkup()}</div>`;
    bindNavigation();
    if (!currentUser) bindAuthDialog();
    root.querySelector("[data-dismiss-shared]")?.addEventListener("click", () => {
      clearSharedInvitation();
      navigate("/inicio");
    });
    root.querySelector<HTMLButtonElement>("[data-accept-shared]")?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const error = root.querySelector<HTMLElement>(".shared-invite-error");
      button.disabled = true;
      button.innerHTML = `${icon("play")} Preparando la partida…`;
      if (error) error.textContent = "";
      try {
        const result = await api.acceptLinkInvitation(token);
        clearSharedInvitation();
        navigate(`/partida/${result.game.id}`);
      } catch (acceptError) {
        if (error) error.textContent = errorMessage(acceptError);
        button.disabled = false;
        button.innerHTML = `${icon("play")} Aceptar y jugar`;
      }
    });
  } catch (error) {
    const content = `<section class="shared-invitation-page">${errorState(errorMessage(error))}<button class="text-button" data-dismiss-shared>Volver al inicio</button></section>`;
    root.innerHTML = currentUser
      ? appLayout(content)
      : `<div class="landing">${publicHeader()}<main>${content}</main>${authDialogMarkup()}</div>`;
    bindNavigation();
    if (!currentUser) bindAuthDialog();
    root.querySelector("[data-dismiss-shared]")?.addEventListener("click", () => {
      clearSharedInvitation();
      navigate("/inicio");
    });
  }
}

function legendAvatarMarkup(
  legend: Legend,
  className = "",
  lazy = false,
) {
  return `<span class="machine-avatar ${className}" role="img" aria-label="Retrato de ${escapeHtml(legend.name)}"><span aria-hidden="true">${escapeHtml(legend.sigil)}</span><img src="${escapeHtml(legend.portrait)}" alt="" width="128" height="128" decoding="async"${lazy ? ' loading="lazy"' : ""}></span>`;
}

function legendRoadCardMarkup(
  legend: Legend,
  unlocked: boolean,
  defeated: boolean,
) {
  const chapter = legend.level <= 5
    ? "I · Fundamentos"
    : legend.level <= 10
      ? "II · Táctica"
      : legend.level <= 15
        ? "III · Maestría"
        : legend.level <= 20
          ? "IV · El Trono"
          : "V · Los Inmortales";
  const state = defeated ? "is-defeated" : unlocked ? "is-unlocked" : "is-locked";
  return `<article class="legend-road-card ${state}" style="--legend-accent:${legend.accent}">
    <span class="legend-road-level"><i>${legend.level}</i></span>
    ${legendAvatarMarkup(legend, "legend-road-avatar", true)}
    <div class="legend-road-copy"><small>ACTO ${chapter} · NIVEL ${legend.level}</small><h2>${escapeHtml(legend.name)}</h2><b>${escapeHtml(legend.epithet)} · ${escapeHtml(legend.difficulty)}</b><p>${escapeHtml(legend.description)}</p><div class="legend-strength" aria-label="Dificultad ${legend.level} de ${LEGENDS.length}">${LEGENDS.map((_, index) => `<i class="${index < legend.level ? "is-filled" : ""}"></i>`).join("")}</div></div>
    <div class="legend-road-action"><span>${defeated ? "✓ Superado" : unlocked ? `${legend.rating.toLocaleString(localeCode())} fuerza` : "Bloqueado"}</span>${unlocked ? `<button class="button ${legend.level === LEGENDS.length ? "button--legend" : "button--outline"} button--small" type="button" data-play-legend="${legend.key}">${defeated ? "Jugar de nuevo" : "Desafiar"}</button>` : `<i aria-label="Nivel bloqueado">🔒</i>`}</div>
    <span class="legend-road-connector" aria-hidden="true"></span>
  </article>`;
}

async function renderLegendRoadmap(timeControl: TimeControl) {
  if (!currentUser) return renderLanding();
  pageCleanup?.();
  pageCleanup = null;
  root.innerHTML = appLayout(loadingMarkup("Abriendo el Camino de Leyendas…"), "game");
  bindNavigation();
  try {
    const response = await api.machineProgress();
    const progress = response.progress["10"] || { unlockedCount: 1, defeatedKeys: [] };
    const defeated = new Set<LegendDifficultyKey>(progress.defeatedKeys);
    const unlockedCount = Math.min(Math.max(progress.unlockedCount, 1), LEGENDS.length);
    const defeatedCount = LEGENDS.filter((legend) => defeated.has(legend.key)).length;
    const nextLegend = LEGENDS.find(
      (legend, index) => index < unlockedCount && !defeated.has(legend.key),
    ) || LEGENDS[Math.min(unlockedCount - 1, LEGENDS.length - 1)];
    root.innerHTML = appLayout(`<section class="legend-road-page">
      <header class="legend-road-hero">
        <div><button class="text-button" type="button" data-route="/inicio">← Volver al inicio</button><span class="eyebrow"><i></i>25 RIVALES · 5 ACTOS</span><h1>Camino de Leyendas</h1><p>Supera veinticinco personajes mitológicos, desde un espíritu ideal para aprender hasta Thanatos, la muerte misma. Cada victoria abre el siguiente duelo.</p></div>
        <div class="legend-road-progress"><span>${icon("crown")}</span><p><small>CAMINO COMPLETADO</small><b>${defeatedCount} <i>/ ${LEGENDS.length}</i></b><em><i style="width:${(defeatedCount / LEGENDS.length) * 100}%"></i></em></p></div>
      </header>
      <section class="legend-road-toolbar panel"><div><span class="section-kicker">RELOJ POR JUGADOR</span><div>${TIME_CONTROLS.map((minutes) => `<button class="${minutes === timeControl ? "is-active" : ""}" type="button" data-legend-road-time="${minutes}">${minutes} min</button>`).join("")}</div></div><p><b>Práctica sin riesgo</b><small>Estas partidas no modifican tu Elo Damas.</small></p>${nextLegend ? `<button class="button button--legend" type="button" data-play-legend="${nextLegend.key}">${icon("play")} Continuar con ${escapeHtml(nextLegend.name)}</button>` : ""}</section>
      <section class="legend-roadmap" aria-label="Progresión de leyendas">
        ${LEGENDS.map((legend, index) => legendRoadCardMarkup(legend, index < unlockedCount, defeated.has(legend.key))).join("")}
      </section>
      <aside class="legend-road-help"><span>i</span><p><b>Cinco actos, veinticinco leyendas</b><small>Fundamentos, Táctica, Maestría, El Trono y Los Inmortales. Cada victoria queda guardada y desbloquea el siguiente personaje en todos tus dispositivos.</small></p></aside>
    </section>`, "game");
    bindNavigation();
    root.querySelectorAll<HTMLButtonElement>("[data-legend-road-time]").forEach((button) => {
      button.addEventListener("click", () => navigate(`/leyendas/${button.dataset.legendRoadTime}`));
    });
    root.querySelectorAll<HTMLButtonElement>("[data-play-legend]").forEach((button) => {
      button.addEventListener("click", () => navigate(`/leyenda/${button.dataset.playLegend}/${timeControl}`));
    });
  } catch (error) {
    root.innerHTML = appLayout(errorState(errorMessage(error)), "game");
    bindNavigation();
    bindRetry(() => void renderLegendRoadmap(timeControl));
  }
}

async function renderLegendGame(
  timeControl: TimeControl,
  difficultyKey: LegendDifficultyKey,
) {
  if (!currentUser) return renderLanding();
  pageCleanup?.();
  pageCleanup = null;
  const selectedLegend = legendByKey(difficultyKey);
  if (!selectedLegend) return navigate(`/leyendas/${timeControl}`);
  const legend: Legend = selectedLegend;
  root.innerHTML = appLayout(loadingMarkup(`Preparando el duelo contra ${legend.name}…`), "game");
  bindNavigation();
  let unlockedBefore = 1;
  try {
    const progressResponse = await api.machineProgress();
    const progress = progressResponse.progress["10"] || { unlockedCount: 1, defeatedKeys: [] };
    unlockedBefore = progress.unlockedCount;
    const index = legendIndex(legend.key);
    if (index >= progress.unlockedCount && !progress.defeatedKeys.includes(legend.key)) {
      toast("Primero debes vencer a la leyenda anterior.", "error");
      return navigate(`/leyendas/${timeControl}`);
    }
  } catch (error) {
    root.innerHTML = appLayout(errorState(errorMessage(error)), "game");
    bindNavigation();
    bindRetry(() => void renderLegendGame(timeControl, difficultyKey));
    return;
  }
  const humanSide: Side = "ivory";
  const machineSide: Side = "mahogany";
  let position: BoardState = createInitialBoard();
  let currentPlayer: Side = humanSide;
  let status: "active" | "completed" = "active";
  let winner: Side | null = null;
  let endReason = "";
  let thinking = false;
  const gameStartedAt = performance.now();
  let turnStartedAt = performance.now();
  const clocks: Record<Side, number> = {
    ivory: timeControl * 60_000,
    mahogany: timeControl * 60_000,
  };
  const moves: Array<{ player: Side; notation: string }> = [];
  let clockTimer = 0;
  let machineTimer = 0;
  let aiWorker: Worker | null = null;
  let aiRequestId = 0;
  let board: CmCheckersboard | null = null;
  let victoryRecorded = false;
  let nextLegendUnlocked = legendIndex(legend.key) + 1 < unlockedBefore;
  const nextLegend = LEGENDS[legendIndex(legend.key) + 1] || null;

  root.innerHTML = appLayout(`
    <section class="game-page legend-game" style="--legend-accent:${legend.accent}">
      <header class="game-titlebar"><button class="text-button" data-route="/leyendas/${timeControl}">← Camino de Leyendas</button><span class="mode-pill mode-pill--legend">${escapeHtml(legend.difficulty)} · ${timeControl} min</span><strong class="game-state-label">Tu turno</strong></header>
      <div class="game-layout">
        <section class="board-column">
          <div class="player-bar player-bar--opponent" data-player-bar="mahogany">
            <div class="player-identity">${legendAvatarMarkup(legend)}<span><span class="player-name-line"><i title="Rival virtual">🌐</i><b>${escapeHtml(legend.name)}</b></span><small>${escapeHtml(legend.epithet)} · ${escapeHtml(legend.difficulty)}</small></span></div>
            ${playerLiveData("mahogany", legend.rating, 20, formatClock(clocks.mahogany))}
            <div class="turn-indicator"><i></i><span data-machine-state>Jugando</span></div>
          </div>
          <div class="board-shell board-shell--legend"><div id="legend-board"></div><div class="board-result-overlay" aria-hidden="true"></div></div>
          <div class="player-bar player-bar--own" data-player-bar="ivory">
            ${playerProfileButton(currentUser, `<span class="avatar-slot" data-current-user-avatar data-avatar-class="avatar avatar--player">${avatarMarkup(currentUser, "avatar avatar--player")}</span><span><span class="player-name-line"><i title="${escapeHtml(currentUser.countryCode)}">${flag(currentUser.countryCode)}</i><b>${escapeHtml(currentUser.name)} (Tú)</b>${worldTrophyMarkup(currentUser, "world-trophy--game")}</span><small>@${escapeHtml(currentUser.username)} · práctica</small></span>`, "player-identity")}
            ${playerLiveData("ivory", currentRating?.rating ?? 1200, 20, formatClock(clocks.ivory))}
            <div class="turn-indicator"><i></i><span>Jugando</span></div>
            ${gameQuickActions(false)}
          </div>
        </section>
        <aside class="game-sidebar legend-sidebar">
          <div class="legend-profile">
            ${legendAvatarMarkup(legend, "machine-avatar--large")}
            <span class="section-kicker">LEYENDA ${legend.level} DE ${LEGENDS.length}</span>
            <h2>${escapeHtml(legend.name)}</h2>
            <b>${escapeHtml(legend.epithet)}</b>
            <p>${escapeHtml(legend.description)}</p>
            <div class="legend-profile-strength">${LEGENDS.map((_, index) => `<i class="${index < legend.level ? "is-filled" : ""}"></i>`).join("")}</div>
            <span class="no-elo-badge">Práctica · No afecta tu Elo Damas</span>
          </div>
          <div class="legend-moves"><h3>Registro de jugadas</h3><div class="moves-list"></div></div>
        </aside>
      </div>
    </section>`, "game");
  bindNavigation();
  const boardElement = root.querySelector<HTMLElement>("#legend-board");
  if (!boardElement) return;

  function displayedClock(side: Side) {
    if (status !== "active" || currentPlayer !== side) return clocks[side];
    return Math.max(clocks[side] - (performance.now() - turnStartedAt), 0);
  }

  function consumeTurnClock() {
    clocks[currentPlayer] = displayedClock(currentPlayer);
    turnStartedAt = performance.now();
    if (clocks[currentPlayer] <= 0) {
      finish(opponentOf(currentPlayer), "timeout");
      return false;
    }
    return true;
  }

  function finish(nextWinner: Side, reason: string) {
    if (status !== "active") return;
    clocks[currentPlayer] = displayedClock(currentPlayer);
    status = "completed";
    winner = nextWinner;
    endReason = reason;
    thinking = false;
    window.clearTimeout(machineTimer);
    aiWorker?.terminate();
    aiWorker = null;
    renderState();
    showGameCompletionAd();
    if (nextWinner === humanSide && !victoryRecorded) {
      void recordLegendVictory();
    }
  }

  async function recordLegendVictory() {
    victoryRecorded = true;
    try {
      const progress = await api.recordMachineWin(legend.key);
      nextLegendUnlocked = Boolean(nextLegend) &&
        progress.unlockedCount > legendIndex(legend.key) + 1;
      if (progress.justUnlocked && nextLegend) {
        toast(`Desbloqueaste a ${nextLegend.name}.`);
      } else if (!nextLegend) {
        toast("¡Completaste el Camino de Leyendas!");
      }
      renderResult();
    } catch (error) {
      toast(`La victoria no pudo guardarse: ${errorMessage(error)}`, "error");
    }
  }

  function playMove(move: LegalMove, player: Side) {
    if (status !== "active" || currentPlayer !== player || !consumeTurnClock()) return;
    position = applyMove(position, move);
    moves.push({ player, notation: moveNotation(move) });
    playMoveSound(move.captures);
    const nextPlayer = opponentOf(player);
    const boardWinner = getWinner(position, nextPlayer);
    if (boardWinner) {
      finish(boardWinner, "board");
      return;
    }
    currentPlayer = nextPlayer;
    turnStartedAt = performance.now();
    renderState();
    if (currentPlayer === machineSide) scheduleMachineMove();
  }

  function calculateMachineMove() {
    const boardSnapshot = position;
    const requestId = ++aiRequestId;
    aiWorker?.terminate();
    const worker = new Worker(
      new URL("./game/legendAi.worker.ts", import.meta.url),
      { type: "module", name: "kingdamas-legend-ai" },
    );
    aiWorker = worker;
    return new Promise<LegalMove | null>((resolve) => {
      const complete = (move: LegalMove | null) => {
        if (aiWorker === worker) aiWorker = null;
        worker.terminate();
        resolve(move);
      };
      worker.addEventListener("message", (event: MessageEvent<{ requestId: number; move: LegalMove | null }>) => {
        if (event.data.requestId === requestId) complete(event.data.move);
      });
      worker.addEventListener("error", () => {
        worker.terminate();
        if (aiWorker === worker) aiWorker = null;
        void import("./game/legendAi")
          .then(({ chooseLegendMove }) => complete(
            chooseLegendMove(boardSnapshot, machineSide, legend.key),
          ))
          .catch(() => complete(null));
      }, { once: true });
      worker.postMessage({
        requestId,
        board: boardSnapshot,
        player: machineSide,
        difficultyKey: legend.key,
      });
    });
  }

  function scheduleMachineMove() {
    if (status !== "active" || currentPlayer !== machineSide) return;
    thinking = true;
    renderState();
    machineTimer = window.setTimeout(async () => {
      if (status !== "active" || currentPlayer !== machineSide) return;
      const move = await calculateMachineMove();
      if (status !== "active" || currentPlayer !== machineSide) return;
      thinking = false;
      if (!move) {
        finish(humanSide, "board");
        return;
      }
      playMove(move, machineSide);
    }, legend.ai.thinkTimeMs);
  }

  function renderMoveList() {
    const list = root.querySelector<HTMLElement>(".legend-moves .moves-list");
    if (!list) return;
    if (!moves.length) {
      list.innerHTML = `<div class="moves-empty"><span>1.</span><p>Haz tu primera jugada.</p></div>`;
      return;
    }
    const rows: string[] = [];
    for (let index = 0; index < moves.length; index += 2) {
      rows.push(`<div class="move-row"><span>${Math.floor(index / 2) + 1}.</span><b>${escapeHtml(moves[index]?.notation)}</b><b>${escapeHtml(moves[index + 1]?.notation || "")}</b></div>`);
    }
    list.innerHTML = rows.join("");
    list.scrollTop = list.scrollHeight;
  }

  function renderResult() {
    const container = root.querySelector<HTMLElement>(".board-result-overlay");
    if (!container || status === "active") {
      container?.classList.remove("is-visible");
      container?.setAttribute("aria-hidden", "true");
      return;
    }
    const humanWon = winner === humanSide;
    const duration = formatDuration(Math.floor((performance.now() - gameStartedAt) / 1000));
    container.innerHTML = `<div class="board-result-card">
      <span class="result-icon">${humanWon ? "♛" : "·"}</span>
      <span class="section-kicker">DUELO FINALIZADO</span>
      <h2>${humanWon ? `Venciste a ${escapeHtml(legend.name)}` : `${escapeHtml(legend.name)} venció`}</h2>
      <p>${endReason === "timeout" ? "El reloj decidió la partida." : endReason === "resignation" ? "La partida terminó por rendición." : "La posición decidió la partida."}</p>
      <div class="result-summary"><span><small>Jugadas</small><b>${moves.length}</b></span><span><small>Duración</small><b>${duration}</b></span><span><small>Elo</small><b>Sin cambios</b></span></div>
      <div class="result-actions">${humanWon && nextLegend ? `<button class="button button--legend" data-result-next ${nextLegendUnlocked ? "" : "disabled"}>${icon("play")} ${nextLegendUnlocked ? `Siguiente: ${escapeHtml(nextLegend.name)}` : "Guardando victoria…"}</button>` : ""}<button class="button button--outline" data-result-rematch>${icon("refresh")} Revancha</button><button class="button button--quiet" data-result-road>Volver al camino</button></div>
    </div>`;
    container.classList.add("is-visible");
    container.setAttribute("aria-hidden", "false");
    container.querySelector("[data-result-next]")?.addEventListener("click", () => {
      if (nextLegend) navigate(`/leyenda/${nextLegend.key}/${timeControl}`);
    });
    container.querySelector("[data-result-rematch]")?.addEventListener("click", () => void renderLegendGame(timeControl, legend.key));
    container.querySelector("[data-result-road]")?.addEventListener("click", () => navigate(`/leyendas/${timeControl}`));
  }

  function refreshClocks() {
    root.querySelectorAll<HTMLElement>("[data-clock]").forEach((element) => {
      const side = element.dataset.clock as Side;
      const value = displayedClock(side);
      element.textContent = formatClock(value);
      element.classList.toggle("is-low", value < 60_000);
      if (status === "active" && value <= 0) finish(opponentOf(side), "timeout");
    });
  }

  function renderState() {
    board?.update(position, currentPlayer, status === "active" && currentPlayer === humanSide && !thinking);
    const pieces = countPieces(position);
    root.querySelectorAll<HTMLElement>("[data-piece-count]").forEach((element) => {
      const side = element.dataset.pieceCount as Side;
      element.textContent = String(pieces[side].total);
    });
    root.querySelectorAll<HTMLElement>("[data-player-bar]").forEach((bar) => {
      bar.classList.toggle("is-turn", status === "active" && bar.dataset.playerBar === currentPlayer);
    });
    const label = root.querySelector<HTMLElement>(".game-state-label");
    if (label) label.textContent = status === "completed"
      ? winner === humanSide ? "Victoria" : "Derrota"
      : currentPlayer === humanSide ? "Tu turno" : thinking ? `${legend.name} está pensando…` : `Turno de ${legend.name}`;
    const machineState = root.querySelector<HTMLElement>("[data-machine-state]");
    if (machineState) machineState.textContent = thinking ? "Pensando" : "Jugando";
    const resign = root.querySelector<HTMLButtonElement>("[data-settings-resign]");
    if (resign) resign.disabled = status !== "active";
    renderMoveList();
    renderResult();
    refreshClocks();
  }

  board = new CmCheckersboard(boardElement, {
    orientation: humanSide,
    playerSide: humanSide,
    pieceColors: pieceColorsFor(humanSide),
    onMove: (move) => playMove(move, humanSide),
  });
  bindGameSettings({
    onPieceColorsChange: (preferences) => {
      board?.setPieceColors(pieceColorsFor(humanSide, preferences));
    },
    onResign: async () => {
      const accepted = await confirmAction({
        title: `¿Rendirse ante ${legend.name}?`,
        message: "La leyenda ganará el duelo y esta partida terminará inmediatamente.",
        confirmLabel: "Rendirme",
      });
      if (accepted) finish(machineSide, "resignation");
    },
    onNewGame: async () => {
      if (status === "active" && !(await confirmAction({
        title: "¿Comenzar otra partida?",
        message: "El duelo actual terminará como una rendición antes de preparar un tablero nuevo.",
        confirmLabel: "Terminar y comenzar otra",
      }))) return;
      if (status === "active") finish(machineSide, "resignation");
      void renderLegendGame(timeControl, legend.key);
    },
  });
  startBackgroundSound();
  clockTimer = window.setInterval(refreshClocks, 250);
  renderState();

  pageCleanup = () => {
    board?.destroy();
    window.clearInterval(clockTimer);
    window.clearTimeout(machineTimer);
    aiWorker?.terminate();
    aiWorker = null;
    stopBackgroundSound();
  };
}

function spectatorCardMarkup(game: SpectatorGameSummary) {
  const ivory = game.players.ivory;
  const mahogany = game.players.mahogany;
  const currentName = game.players[game.currentPlayer].name;
  return `<article class="live-game-card">
    <header><span class="live-badge"><i></i> EN DIRECTO</span><span>${icon("eye")} <b>${game.spectatorCount}</b></span></header>
    <div class="live-players">
      ${playerProfileButton(ivory, `${avatarMarkup(ivory, "avatar avatar--live")}<span><small>${flag(ivory.countryCode)} @${escapeHtml(ivory.username)}</small><span class="live-player-name"><b>${escapeHtml(ivory.name)}</b>${worldTrophyMarkup(ivory)}</span><em>${ivory.rating.rating.toLocaleString(localeCode())} Elo Damas</em></span>`, `live-player ${game.currentPlayer === "ivory" ? "is-turn" : ""}`)}
      <span class="live-versus">VS</span>
      ${playerProfileButton(mahogany, `${avatarMarkup(mahogany, "avatar avatar--live")}<span><small>${flag(mahogany.countryCode)} @${escapeHtml(mahogany.username)}</small><span class="live-player-name"><b>${escapeHtml(mahogany.name)}</b>${worldTrophyMarkup(mahogany)}</span><em>${mahogany.rating.rating.toLocaleString(localeCode())} Elo Damas</em></span>`, `live-player ${game.currentPlayer === "mahogany" ? "is-turn" : ""}`)}
    </div>
    <div class="live-game-facts"><span><small>Ritmo</small><b>${game.timeControlMinutes} min</b></span><span><small>Jugadas</small><b>${game.moveCount}</b></span><span><small>Turno</small><b>${escapeHtml(currentName)}</b></span></div>
    <button class="button button--primary" type="button" data-watch-game="${game.id}">${icon("eye")} Ver partida</button>
  </article>`;
}

function liveGamesListMarkup(games: SpectatorGameSummary[]) {
  if (!games.length) {
    return `<div class="live-games-empty"><span>${icon("eye")}</span><h2>No hay partidas públicas en curso</h2><p>Cuando dos jugadores comiencen una partida clasificada, aparecerá aquí automáticamente.</p><button class="button button--primary" type="button" data-route="/jugar">Buscar rival</button></div>`;
  }
  return games.map(spectatorCardMarkup).join("");
}

function bindLiveGameCards() {
  root.querySelectorAll<HTMLButtonElement>("[data-watch-game]").forEach((button) => {
    button.addEventListener("click", () => navigate(`/espectar/${button.dataset.watchGame}`));
  });
  bindNavigation();
}

async function renderLiveGames() {
  root.innerHTML = appLayout(loadingMarkup("Buscando partidas en directo…"), "watch");
  bindNavigation();
  try {
    const response = await api.spectatorGames();
    if (route() !== "/en-vivo") return;
    root.innerHTML = appLayout(`
      <section class="page-heading live-games-heading"><div><span class="eyebrow"><i></i>OBSERVA · APRENDE · DISFRUTA</span><h1>Partidas en vivo</h1><p>Sigue las decisiones de otros jugadores sobre el tablero, jugada por jugada y sin intervenir.</p></div><span class="live-total"><i></i><b data-live-total>${response.total}</b><small>en directo</small></span></section>
      <section class="live-games-toolbar"><span>${icon("eye")} Solo se muestran partidas clasificadas públicas</span><button class="text-button" type="button" data-refresh-live>${icon("refresh")} Actualizar</button></section>
      <section class="live-games-grid" data-live-games></section>
    `, "watch");
    let games = [...response.games];
    let gamesOffset = response.nextOffset;
    let gamesHaveMore = response.hasMore;
    let gamesLoading = false;

    const renderGames = () => {
      const list = root.querySelector<HTMLElement>("[data-live-games]");
      if (!list) return;
      list.innerHTML = `${liveGamesListMarkup(games)}${communityListMoreMarkup("live-games", gamesHaveMore)}`;
      bindLiveGameCards();
      list.querySelector<HTMLButtonElement>("[data-load-more-live-games]")
        ?.addEventListener("click", async (event) => {
          if (gamesLoading) return;
          gamesLoading = true;
          const button = event.currentTarget as HTMLButtonElement;
          button.disabled = true;
          button.textContent = "Cargando…";
          try {
            const page = await api.spectatorGames(gamesOffset);
            const knownIds = new Set(games.map((game) => game.id));
            games.push(...page.games.filter((game) => !knownIds.has(game.id)));
            gamesOffset = page.nextOffset;
            gamesHaveMore = page.hasMore;
            const total = root.querySelector<HTMLElement>("[data-live-total]");
            if (total) total.textContent = String(page.total);
            renderGames();
          } catch (loadError) {
            button.disabled = false;
            button.textContent = `Ver ${LIST_PAGE_SIZE} más`;
            toast(errorMessage(loadError), "error");
          } finally {
            gamesLoading = false;
          }
        });
    };
    renderGames();

    const refresh = async (force = true) => {
      if (!force && gamesOffset > LIST_PAGE_SIZE) return;
      try {
        const next = await api.spectatorGames();
        if (route() !== "/en-vivo") return;
        const total = root.querySelector<HTMLElement>("[data-live-total]");
        games = next.games;
        gamesOffset = next.nextOffset;
        gamesHaveMore = next.hasMore;
        if (total) total.textContent = String(next.total);
        renderGames();
      } catch {
        // La siguiente actualización vuelve a intentarlo sin vaciar la lista.
      }
    };
    root.querySelector("[data-refresh-live]")?.addEventListener("click", () => void refresh(true));
    const refreshTimer = window.setInterval(() => void refresh(false), 10_000);
    pageCleanup = () => window.clearInterval(refreshTimer);
  } catch (error) {
    root.innerHTML = appLayout(errorState(errorMessage(error)), "watch");
    bindNavigation();
    bindRetry(() => void renderLiveGames());
  }
}

function spectatorPlayerBar(
  player: SpectatorGame["players"][Side],
  side: Side,
  pieces: number,
) {
  return `<div class="player-bar spectator-player-bar" data-player-bar="${side}">
    ${playerProfileButton(player, `${avatarMarkup(player, "avatar avatar--player")}<span><span class="player-name-line"><i title="${escapeHtml(player.countryCode)}">${flag(player.countryCode)}</i><b>${escapeHtml(player.name)}</b>${worldTrophyMarkup(player, "world-trophy--game")}</span><small>@${escapeHtml(player.username)}</small></span>`, "player-identity")}
    ${playerLiveData(side, player.rating.rating, pieces)}
    <div class="turn-indicator"><i></i><span>Jugando</span></div>
  </div>`;
}

function mountSpectatorGame(initialGame: SpectatorGame, initialSpectatorCount: number) {
  let game = initialGame;
  let spectatorCount = initialSpectatorCount;
  let board: CmCheckersboard | null = null;
  let clockTimer = 0;
  let syncTimer = 0;

  root.innerHTML = appLayout(`
    <section class="game-page spectator-game-page">
      <header class="game-titlebar"><button class="text-button" data-route="/en-vivo">← Partidas en vivo</button><span class="game-title-meta"><span class="mode-pill mode-pill--live"><i></i> EN DIRECTO · ${game.timeControlMinutes} min</span><span class="game-viewer-count" aria-label="Espectadores conectados">${icon("eye")} <b data-spectator-count>${spectatorCount}</b></span></span><strong class="game-state-label"></strong></header>
      <div class="spectator-notice"><span>${icon("eye")}</span><p><b>Estás observando esta partida</b><small>El tablero es de solo lectura y se actualiza en tiempo real.</small></p></div>
      <div class="game-layout">
        <section class="board-column">
          ${spectatorPlayerBar(game.players.mahogany, "mahogany", countPieces(game.board).mahogany.total)}
          <div class="board-shell board-shell--spectator"><div id="spectator-board"></div><div class="board-result-overlay" aria-hidden="true"></div></div>
          ${spectatorPlayerBar(game.players.ivory, "ivory", countPieces(game.board).ivory.total)}
        </section>
        <aside class="game-sidebar spectator-sidebar">
          <div class="spectator-sidebar-heading"><span>${icon("eye")}</span><div><small>TRANSMISIÓN EN VIVO</small><b><span data-spectator-count>${spectatorCount}</span> ${spectatorCount === 1 ? "espectador" : "espectadores"}</b></div></div>
          <div class="moves-panel"><div class="spectator-moves-title"><span>Registro de jugadas</span><small>${game.moveCount} movimientos</small></div><div class="moves-list"></div></div>
          <div class="spectator-fair-play"><span>◎</span><p><b>Vista neutral</b><small>No se muestran el chat ni las ofertas privadas entre jugadores.</small></p></div>
        </aside>
      </div>
    </section>
  `, "watch");
  bindNavigation();
  const boardElement = root.querySelector<HTMLElement>("#spectator-board");
  if (!boardElement) return;
  board = new CmCheckersboard(boardElement, {
    orientation: "ivory",
    playerSide: "ivory",
    pieceColors: game.pieceColors,
    onMove: () => {},
  });

  const clockValue = (side: Side) => {
    return spectatorClockValue(game.clocks, game.status, side);
  };

  const refreshClocks = () => {
    root.querySelectorAll<HTMLElement>("[data-clock]").forEach((element) => {
      const side = element.dataset.clock as Side;
      element.textContent = formatClock(clockValue(side));
      element.classList.toggle("is-low", clockValue(side) < 60_000);
    });
  };

  const renderMoves = () => {
    const list = root.querySelector<HTMLElement>(".spectator-sidebar .moves-list");
    const title = root.querySelector<HTMLElement>(".spectator-moves-title small");
    if (title) title.textContent = `${game.moveCount} movimientos`;
    if (!list) return;
    if (!game.moves.length) {
      list.innerHTML = `<div class="moves-empty"><span>1.</span><p>Esperando la primera jugada.</p></div>`;
      return;
    }
    const rows: string[] = [];
    for (let index = 0; index < game.moves.length; index += 2) {
      rows.push(`<div class="move-row"><span>${Math.floor(index / 2) + 1}.</span><b>${escapeHtml(game.moves[index]?.notation)}</b><b>${escapeHtml(game.moves[index + 1]?.notation || "")}</b></div>`);
    }
    list.innerHTML = rows.join("");
    list.scrollTop = list.scrollHeight;
  };

  const renderResult = () => {
    const container = root.querySelector<HTMLElement>(".board-result-overlay");
    if (!container || game.status === "active") {
      container?.classList.remove("is-visible");
      container?.setAttribute("aria-hidden", "true");
      return;
    }
    const winner = game.winner ? game.players[game.winner] : null;
    container.innerHTML = `<div class="board-result-card"><span class="result-icon">${winner ? "♛" : "½"}</span><span class="section-kicker">TRANSMISIÓN FINALIZADA</span><h2 class="result-winner-name">${winner ? `<span>Victoria de ${escapeHtml(winner.name)}</span>${worldTrophyMarkup(winner, "world-trophy--result")}` : "Tablas"}</h2>${winner ? worldTitleRecognitionMarkup(winner, "world-title-recognition--result") : ""}<p>${endReasonLabel(game.endReason)}</p><div class="result-summary"><span><small>Jugadas</small><b>${game.moveCount}</b></span><span><small>Ritmo</small><b>${game.timeControlMinutes} min</b></span><span><small>Espectadores</small><b>${spectatorCount}</b></span></div><div class="result-actions"><button class="button button--primary" type="button" data-result-live>${icon("eye")} Ver otras partidas</button><button class="button button--quiet" type="button" data-result-home>Volver al inicio</button></div></div>`;
    container.classList.add("is-visible");
    container.setAttribute("aria-hidden", "false");
    container.querySelector("[data-result-live]")?.addEventListener("click", () => navigate("/en-vivo"));
    container.querySelector("[data-result-home]")?.addEventListener("click", () => navigate("/inicio"));
  };

  const renderSpectatorCount = () => {
    root.querySelectorAll<HTMLElement>("[data-spectator-count]").forEach((element) => {
      element.textContent = String(spectatorCount);
    });
    const label = root.querySelector<HTMLElement>(".spectator-sidebar-heading b");
    if (label) label.innerHTML = `<span data-spectator-count>${spectatorCount}</span> ${spectatorCount === 1 ? "espectador" : "espectadores"}`;
  };

  const update = (next: SpectatorGame) => {
    const previousMoveCount = game.moveCount;
    game = next;
    board?.setPieceColors(game.pieceColors);
    if (game.moveCount > previousMoveCount) playMoveSound(game.moves.at(-1)?.captures ?? 0);
    board?.update(game.board, game.currentPlayer, false);
    const pieces = countPieces(game.board);
    root.querySelectorAll<HTMLElement>("[data-piece-count]").forEach((element) => {
      const side = element.dataset.pieceCount as Side;
      element.textContent = String(pieces[side].total);
    });
    root.querySelectorAll<HTMLElement>("[data-player-bar]").forEach((bar) => {
      bar.classList.toggle("is-turn", game.status === "active" && bar.dataset.playerBar === game.currentPlayer);
    });
    const state = root.querySelector<HTMLElement>(".game-state-label");
    if (state) state.textContent = game.status === "active"
      ? `Turno de ${game.players[game.currentPlayer].name}`
      : game.winner ? `Ganó ${game.players[game.winner].name}` : "Tablas";
    renderMoves();
    renderResult();
    refreshClocks();
  };

  const socketGameUpdate = (next: SpectatorGame) => {
    if (String(next.id) === game.id) update(next);
  };
  const socketSpectatorUpdate = (payload: { gameId: string; count: number }) => {
    if (String(payload.gameId) !== game.id) return;
    spectatorCount = Math.max(Number(payload.count) || 0, 0);
    renderSpectatorCount();
    if (game.status !== "active") renderResult();
  };

  const joinSpectatorRoom = () => {
    socket?.emit("spectator:join", game.id, (result: { ok: boolean; spectatorCount?: number; error?: string }) => {
      if (!result?.ok) {
        toast(result?.error || "No se pudo abrir la transmisión.", "error");
        return;
      }
      spectatorCount = result.spectatorCount ?? spectatorCount;
      renderSpectatorCount();
    });
  };
  if (socket?.connected) joinSpectatorRoom();
  socket?.on("connect", joinSpectatorRoom);
  socket?.on("game:updated", socketGameUpdate);
  socket?.on("game:spectators", socketSpectatorUpdate);
  clockTimer = window.setInterval(refreshClocks, 250);
  syncTimer = window.setInterval(() => {
    void api.spectatorGame(game.id).then((response) => {
      update(response.game);
      spectatorCount = response.spectatorCount;
      renderSpectatorCount();
    }).catch(() => {});
  }, 10_000);
  startBackgroundSound();
  update(game);
  renderSpectatorCount();

  pageCleanup = () => {
    board?.destroy();
    window.clearInterval(clockTimer);
    window.clearInterval(syncTimer);
    socket?.emit("spectator:leave", game.id);
    socket?.off("connect", joinSpectatorRoom);
    socket?.off("game:updated", socketGameUpdate);
    socket?.off("game:spectators", socketSpectatorUpdate);
    stopBackgroundSound();
  };
}

async function renderSpectatorGame(gameId: string) {
  root.innerHTML = appLayout(loadingMarkup("Abriendo la transmisión…"), "watch");
  bindNavigation();
  try {
    const response = await api.spectatorGame(gameId);
    if (route() !== `/espectar/${gameId}`) return;
    mountSpectatorGame(response.game, response.spectatorCount);
  } catch (error) {
    root.innerHTML = appLayout(errorState(errorMessage(error)), "watch");
    bindNavigation();
    bindRetry(() => void renderSpectatorGame(gameId));
  }
}

function gameStatus(game: Game) {
  if (game.status === "active") {
    return game.currentPlayer === game.playerColor ? "Tu turno" : "Turno del rival";
  }
  if (game.status === "cancelled") return "Partida cancelada";
  if (!game.winner) return "Tablas";
  return game.winner === game.playerColor ? "Victoria" : "Derrota";
}

async function renderGame(gameId: string) {
  root.innerHTML = appLayout(loadingMarkup("Colocando las fichas…"), "game");
  bindNavigation();
  try {
    const response = await api.game(gameId);
    mountGame(response.game);
  } catch (error) {
    root.innerHTML = appLayout(errorState(errorMessage(error)), "game");
    bindNavigation();
    bindRetry(() => renderGame(gameId));
  }
}

function mountGame(initialGame: Game) {
  let game = initialGame;
  const ownSide = game.playerColor;
  const opponentSide: Side = ownSide === "ivory" ? "mahogany" : "ivory";
  const own = game.players[ownSide];
  const opponent = game.players[opponentSide];
  let submittingMove = false;
  let clockTimer = 0;
  let syncTimer = 0;
  let rematchTimer = 0;
  let board: CmCheckersboard | null = null;
  let messages: ChatMessage[] = [];
  let messagesBeforeId: string | null = null;
  let messagesHaveMore = false;
  let messageHistoryLoading = false;
  let completedAt = game.status === "active" ? 0 : Date.now();
  let sentRematchId: string | null = null;
  let incomingRematch: DirectInvitation | null = null;
  let rematchState: "idle" | "sending" | "waiting" | "declined" | "error" = "idle";
  let rematchFeedback = "";
  const chatCloudTimers: Partial<Record<Side, number>> = {};

  root.innerHTML = appLayout(`
    <section class="game-page">
      <header class="game-titlebar"><button class="text-button" data-route="/inicio">← Volver al inicio</button><span class="game-title-meta"><span class="mode-pill">10×10 · ${game.timeControlMinutes} min</span><span class="game-viewer-count" aria-label="Espectadores conectados">${icon("eye")} <b data-player-spectator-count>0</b></span></span><strong class="game-state-label"></strong></header>
      <div class="game-layout">
        <section class="board-column">
          ${playerBar(opponent, opponentSide, "opponent", countPieces(game.board)[opponentSide].total)}
          <div class="board-shell"><div id="live-board"></div><div class="board-result-overlay" aria-hidden="true"></div></div>
          ${playerBar(
            own,
            ownSide,
            "own",
            countPieces(game.board)[ownSide].total,
            pieceColorPreferencesForSide(ownSide, game.pieceColors),
          )}
          <div class="draw-offer"></div>
        </section>
        <aside class="game-sidebar">
          <div class="game-tabs"><button class="is-active">Jugada</button><button data-chat-tab>Chat <i class="chat-unread"></i></button></div>
          <div class="moves-panel"><div class="moves-list"></div></div>
          <div class="chat-panel">
            <div class="chat-messages"><div class="chat-placeholder">Aún no hay mensajes.<br>Saluda a tu rival.</div></div>
            <div class="chat-emoji-picker" role="toolbar" aria-label="Emojis desafiantes">${CHALLENGE_EMOJIS.map((emoji) => `<button type="button" data-chat-emoji="${emoji}" aria-label="Enviar ${emoji}">${emoji}</button>`).join("")}</div>
            <form class="chat-form"><label><input maxlength="${MAX_GAME_CHAT_LENGTH}" name="message" autocomplete="off" placeholder="Escribe un mensaje…" aria-label="Mensaje, máximo ${MAX_GAME_CHAT_LENGTH} caracteres" /><small data-chat-counter>0/${MAX_GAME_CHAT_LENGTH}</small></label><button type="submit" aria-label="Enviar">↑</button></form>
          </div>
        </aside>
      </div>
    </section>`, "game");
  bindNavigation();

  const boardElement = root.querySelector<HTMLElement>("#live-board");
  if (!boardElement) return;
  board = new CmCheckersboard(boardElement, {
    orientation: ownSide,
    playerSide: ownSide,
    pieceColors: game.pieceColors,
    onMove: async (move) => {
      if (submittingMove) return;
      submittingMove = true;
      board?.update(game.board, game.currentPlayer, false);
      try {
        const response = await api.move(game.id, move, game.version);
        update(response.game);
      } catch (error) {
        toast(errorMessage(error), "error");
        try { update((await api.game(game.id)).game); } catch { /* El socket reintentará. */ }
      } finally {
        submittingMove = false;
        board?.update(game.board, game.currentPlayer, canMove());
      }
    },
  });

  const canMove = () => game.status === "active" && game.currentPlayer === ownSide && !submittingMove;
  const update = (next: Game) => {
    const previousMoveCount = game.moveCount;
    const wasActive = game.status === "active";
    game = { ...next, playerColor: next.playerColor || ownSide };
    board?.setPieceColors(game.pieceColors);
    syncGamePieceColorControls(
      pieceColorPreferencesForSide(ownSide, game.pieceColors),
    );
    if (wasActive && game.status !== "active") {
      completedAt = Date.now();
      if (game.status === "completed") showGameCompletionAd();
      root.querySelectorAll<HTMLElement>("[data-chat-cloud]").forEach((cloud) => {
        cloud.classList.remove("is-visible");
        cloud.setAttribute("aria-hidden", "true");
      });
      Object.values(chatCloudTimers).forEach((timer) => {
        if (timer) window.clearTimeout(timer);
      });
    }
    if (game.moveCount > previousMoveCount) {
      playMoveSound(game.moves.at(-1)?.captures ?? 0);
    }
    board?.update(game.board, game.currentPlayer, canMove());
    const stateLabel = root.querySelector<HTMLElement>(".game-state-label");
    if (stateLabel) stateLabel.textContent = gameStatus(game);
    root.querySelectorAll<HTMLElement>("[data-player-bar]").forEach((bar) => {
      const side = bar.dataset.playerBar as Side;
      bar.classList.toggle("is-turn", game.status === "active" && game.currentPlayer === side);
    });
    const pieces = countPieces(game.board);
    root.querySelectorAll<HTMLElement>("[data-piece-count]").forEach((element) => {
      const side = element.dataset.pieceCount as Side;
      element.textContent = String(pieces[side].total);
    });
    renderMoves(game);
    renderDrawOffer(game);
    renderResult(game);
    if (game.status !== "active") ensureRematchPolling();
    const endButton = root.querySelector<HTMLButtonElement>("[data-settings-resign]");
    const drawButton = root.querySelector<HTMLButtonElement>("[data-settings-draw]");
    if (endButton) endButton.disabled = game.status !== "active";
    if (drawButton) drawButton.disabled = game.status !== "active" || Boolean(game.drawOffer);
    refreshClocks();
  };

  const clockValue = (side: Side) => {
    const key = side === "ivory" ? "ivoryMs" : "mahoganyMs";
    let value = game.clocks[key];
    if (game.status === "active" && game.clocks.running === side) {
      value -= Math.max(Date.now() - new Date(game.clocks.capturedAt).getTime(), 0);
    }
    return Math.max(value, 0);
  };
  const refreshClocks = () => {
    root.querySelectorAll<HTMLElement>("[data-clock]").forEach((element) => {
      const side = element.dataset.clock as Side;
      element.textContent = formatClock(clockValue(side));
      element.classList.toggle("is-low", clockValue(side) < 60_000);
    });
  };

  const renderMoves = (state: Game) => {
    const list = root.querySelector<HTMLElement>(".moves-list");
    if (!list) return;
    if (!state.moves.length) {
      list.innerHTML = `<div class="moves-empty"><span>1.</span><p>La primera jugada está por escribirse.</p></div>`;
      return;
    }
    const rows: string[] = [];
    for (let index = 0; index < state.moves.length; index += 2) {
      const first = state.moves[index];
      const second = state.moves[index + 1];
      rows.push(`<div class="move-row"><span>${Math.floor(index / 2) + 1}.</span><b>${escapeHtml(first?.notation)}</b><b>${escapeHtml(second?.notation || "")}</b></div>`);
    }
    list.innerHTML = rows.join("");
    list.scrollTop = list.scrollHeight;
  };

  const renderDrawOffer = (state: Game) => {
    const container = root.querySelector<HTMLElement>(".draw-offer");
    if (!container) return;
    if (state.drawOffer?.status === "received") {
      container.innerHTML = `<div><b>Tu rival ofrece tablas</b><span>¿Quieres terminar la partida en empate?</span></div><button class="button button--primary" data-accept-draw>Aceptar</button><button class="button button--quiet" data-decline-draw>Rechazar</button>`;
      container.classList.add("is-visible");
      container.querySelector("[data-accept-draw]")?.addEventListener("click", () => void respondDraw(true));
      container.querySelector("[data-decline-draw]")?.addEventListener("click", () => void respondDraw(false));
    } else if (state.drawOffer?.status === "sent") {
      container.innerHTML = `<div><b>Oferta de tablas enviada</b><span>Esperando la respuesta de tu rival.</span></div>`;
      container.classList.add("is-visible");
    } else {
      container.replaceChildren();
      container.classList.remove("is-visible");
    }
  };

  const renderResult = (state: Game) => {
    const container = root.querySelector<HTMLElement>(".board-result-overlay");
    if (!container || state.status === "active") {
      container?.classList.remove("is-visible");
      container?.setAttribute("aria-hidden", "true");
      return;
    }
    const won = state.winner === ownSide;
    const drawn = !state.winner && state.status === "completed";
    const ownRating = state.ratingResult?.[ownSide];
    const durationSeconds = Math.floor((Math.max(completedAt || Date.now(), new Date(state.startedAt).getTime()) - new Date(state.startedAt).getTime()) / 1000);
    const rematchLabel = incomingRematch
      ? `${icon("refresh")} Aceptar revancha`
      : rematchState === "waiting"
        ? "Esperando al rival…"
        : rematchState === "sending"
          ? "Enviando…"
          : `${icon("refresh")} Pedir revancha`;
    container.innerHTML = `<div class="board-result-card">
      <span class="result-icon">${drawn ? "½" : won ? "♛" : "·"}</span>
      <span class="section-kicker">PARTIDA FINALIZADA</span>
      <h2>${drawn ? "Tablas" : won ? "Victoria" : state.status === "cancelled" ? "Partida cancelada" : "Derrota"}</h2>
      <p>${endReasonLabel(state.endReason)} Rival: <button class="inline-player-profile" type="button" data-player-profile-link="${escapeHtml(opponent.username)}">@${escapeHtml(opponent.username)}</button></p>
      <div class="result-summary"><span><small>Jugadas</small><b>${state.moveCount}</b></span><span><small>Duración</small><b>${formatDuration(durationSeconds)}</b></span><span><small>Elo Damas</small><b class="${(ownRating?.change ?? 0) > 0 ? "is-positive" : (ownRating?.change ?? 0) < 0 ? "is-negative" : ""}">${ownRating ? `${ownRating.after} (${ownRating.change >= 0 ? "+" : ""}${ownRating.change})` : "Sin cambios"}</b></span></div>
      <p class="rematch-feedback">${escapeHtml(rematchFeedback)}</p>
      <div class="result-actions"><button class="button button--primary" data-result-rematch ${rematchState === "waiting" || rematchState === "sending" ? "disabled" : ""}>${rematchLabel}</button><button class="button button--quiet" data-result-other>Otro rival</button></div>
      <button class="text-button result-home" data-result-home>Volver al inicio</button>
    </div>`;
    container.classList.add("is-visible");
    container.setAttribute("aria-hidden", "false");
    container.querySelector("[data-result-rematch]")?.addEventListener("click", () => void handleRematch());
    container.querySelector("[data-result-other]")?.addEventListener("click", () => navigate("/jugar"));
    container.querySelector("[data-result-home]")?.addEventListener("click", () => navigate("/inicio"));
  };

  const handleRematch = async () => {
    rematchState = "sending";
    rematchFeedback = incomingRematch ? "Aceptando la revancha…" : "Enviando la revancha…";
    renderResult(game);
    try {
      if (incomingRematch) {
        const result = await api.acceptInvitation(incomingRematch.id);
        incomingRematch = null;
        sentRematchId = null;
        window.clearInterval(rematchTimer);
        navigate(`/partida/${result.game.id}`);
        return;
      }
      const result = await api.createInvitation(opponent.username, game.timeControlMinutes);
      sentRematchId = result.invitation.id;
      rematchState = "waiting";
      rematchFeedback = `Revancha enviada a @${opponent.username}.`;
      renderResult(game);
      ensureRematchPolling();
    } catch (error) {
      rematchState = "error";
      rematchFeedback = errorMessage(error);
      renderResult(game);
    }
  };

  const checkRematch = async () => {
    if (game.status === "active") return;
    try {
      const incoming = (await api.invitations()).invitations.find((invitation) =>
        invitation.status === "pending" &&
        invitation.opponent.id === opponent.id &&
        invitation.timeControlMinutes === game.timeControlMinutes,
      );
      if (incoming && incoming.id !== incomingRematch?.id) {
        incomingRematch = incoming;
        rematchState = "idle";
        rematchFeedback = `@${opponent.username} quiere una revancha.`;
        renderResult(game);
      }
      if (!sentRematchId) return;
      const result = await api.invitationStatus(sentRematchId);
      if (result.invitation.status === "accepted" && result.game) {
        sentRematchId = null;
        window.clearInterval(rematchTimer);
        navigate(`/partida/${result.game.id}`);
      } else if (result.invitation.status !== "pending") {
        sentRematchId = null;
        rematchState = "declined";
        rematchFeedback = result.invitation.status === "declined"
          ? "Tu rival rechazó la revancha."
          : "La solicitud de revancha ya no está disponible.";
        renderResult(game);
      }
    } catch {
      // El próximo ciclo vuelve a intentarlo sin ocultar el resultado.
    }
  };

  const ensureRematchPolling = () => {
    if (rematchTimer) return;
    rematchTimer = window.setInterval(() => void checkRematch(), 2000);
    void checkRematch();
  };

  const respondDraw = async (accept: boolean) => {
    try { update((await api.respondDraw(game.id, accept)).game); }
    catch (error) { toast(errorMessage(error), "error"); }
  };

  const offerDraw = async () => {
    try { update((await api.offerDraw(game.id)).game); }
    catch (error) { toast(errorMessage(error), "error"); }
  };
  let exitRequestInFlight = false;
  const finishByPlayer = async ({
    title = "¿Abandonar la partida?",
    message = "Si sales ahora, perderás la partida y el resultado quedará registrado.",
    confirmLabel = "Rendirme y salir",
  }: Partial<Pick<ConfirmationDialogOptions, "title" | "message" | "confirmLabel">> = {}) => {
    if (game.status !== "active") return true;
    if (!(await confirmAction({ title, message, confirmLabel }))) return false;
    exitRequestInFlight = true;
    try {
      const response = await api.resign(game.id);
      update(response.game);
      return true;
    } catch (error) {
      exitRequestInFlight = false;
      toast(errorMessage(error), "error");
      return false;
    }
  };
  const leaveGuard = () => finishByPlayer({
    message: "Si cambias de página ahora, perderás la partida y el resultado quedará registrado.",
  });
  pageLeaveGuard = leaveGuard;
  const handleBeforeUnload = (event: BeforeUnloadEvent) => {
    if (game.status !== "active" || exitRequestInFlight) return;
    event.preventDefault();
    event.returnValue = translateText(
      "La partida continuará activa y volverás a ella al regresar.",
    );
  };
  window.addEventListener("beforeunload", handleBeforeUnload);
  const openChat = () => {
    root.querySelector(".game-sidebar")?.classList.toggle("is-open");
    root.querySelector<HTMLInputElement>(".chat-form input")?.focus();
  };
  bindGameSettings({
    onChat: openChat,
    onDraw: offerDraw,
    onPieceColorsChange: async (preferences) => {
      try {
        update((await api.updateGamePieceColors(
          game.id,
          preferences.own,
          preferences.opponent,
        )).game);
      } catch (error) {
        toast(errorMessage(error), "error");
        syncGamePieceColorControls(
          pieceColorPreferencesForSide(ownSide, game.pieceColors),
        );
      }
    },
    onResign: async () => {
      await finishByPlayer({
        title: "¿Confirmas la rendición?",
        message: `La victoria será concedida a ${opponent.name} y el resultado afectará tu Elo Damas.`,
        confirmLabel: "Confirmar rendición",
      });
    },
    onNewGame: async () => {
      if (!(await finishByPlayer({
        title: "¿Comenzar otra partida?",
        message: "Primero debes rendirte. La partida actual contará como derrota y el resultado quedará registrado.",
        confirmLabel: "Rendirme y buscar rival",
      }))) return;
      navigate("/jugar");
    },
  });
  root.querySelector("[data-chat-tab]")?.addEventListener("click", () => root.querySelector(".game-sidebar")?.classList.add("show-chat"));

  const renderMessages = (scrollToBottom = true) => {
    const container = root.querySelector<HTMLElement>(".chat-messages");
    if (!container) return;
    if (!messages.length) {
      container.innerHTML = `<div class="chat-placeholder">Aún no hay mensajes.<br>Saluda a tu rival.</div>`;
      return;
    }
    container.innerHTML = `${communityListMoreMarkup("game-messages", messagesHaveMore)}${messages.map((message) => `<div class="chat-message ${message.senderId === currentUser?.id || message.own ? "is-mine" : ""}"><small><button class="inline-player-profile" type="button" data-player-profile-link="${escapeHtml(message.username)}">@${escapeHtml(message.username)}</button></small><p>${escapeHtml(message.message)}</p><time>${new Date(message.sentAt).toLocaleTimeString(localeCode(), { hour: "2-digit", minute: "2-digit" })}</time></div>`).join("")}`;
    container.querySelector<HTMLButtonElement>("[data-load-more-game-messages]")
      ?.addEventListener("click", () => void loadEarlierGameMessages());
    if (scrollToBottom) container.scrollTop = container.scrollHeight;
  };

  async function loadEarlierGameMessages() {
    const container = root.querySelector<HTMLElement>(".chat-messages");
    if (!container || !messagesBeforeId || !messagesHaveMore || messageHistoryLoading) return;
    messageHistoryLoading = true;
    const button = container.querySelector<HTMLButtonElement>("[data-load-more-game-messages]");
    if (button) {
      button.disabled = true;
      button.textContent = "Cargando…";
    }
    const previousHeight = container.scrollHeight;
    try {
      const response = await api.messages(game.id, messagesBeforeId);
      const knownIds = new Set(messages.map((message) => message.id));
      messages = [...response.messages.filter((message) => !knownIds.has(message.id)), ...messages];
      messagesBeforeId = response.nextBeforeId;
      messagesHaveMore = response.hasMore;
      renderMessages(false);
      container.scrollTop = container.scrollHeight - previousHeight;
    } catch (historyError) {
      if (button) {
        button.disabled = false;
        button.textContent = `Ver ${LIST_PAGE_SIZE} anteriores`;
      }
      toast(errorMessage(historyError), "error");
    } finally {
      messageHistoryLoading = false;
    }
  }

  const showChatCloud = (message: ChatMessage) => {
    if (game.status !== "active") return;
    const side = message.playerColor;
    const cloud = root.querySelector<HTMLElement>(`[data-chat-cloud="${side}"]`);
    if (!cloud) return;
    const username = cloud.querySelector<HTMLElement>("small");
    const content = cloud.querySelector<HTMLElement>("p");
    if (username) username.textContent = `@${message.username}`;
    if (content) content.textContent = message.message;
    cloud.classList.toggle("is-emoji", message.kind === "emoji");
    cloud.classList.remove("is-visible");
    void cloud.offsetWidth;
    cloud.classList.add("is-visible");
    cloud.setAttribute("aria-hidden", "false");
    if (chatCloudTimers[side]) window.clearTimeout(chatCloudTimers[side]);
    chatCloudTimers[side] = window.setTimeout(() => {
      cloud.classList.remove("is-visible");
      cloud.setAttribute("aria-hidden", "true");
      chatCloudTimers[side] = undefined;
    }, 4_500);
  };

  const addLiveMessage = (message: ChatMessage) => {
    if (String(message.gameId) !== game.id || messages.some((item) => item.id === message.id)) return;
    messages.push(message);
    renderMessages();
    showChatCloud(message);
  };

  const sendChatMessage = async (value: string, kind: "text" | "emoji") => {
    try {
      addLiveMessage((await api.sendMessage(game.id, value, kind)).message);
      return true;
    } catch (error) {
      toast(errorMessage(error), "error");
      return false;
    }
  };

  const chatForm = root.querySelector<HTMLFormElement>(".chat-form");
  const chatInput = chatForm?.elements.namedItem("message") as HTMLInputElement | null;
  const chatCounter = root.querySelector<HTMLElement>("[data-chat-counter]");
  const updateChatCounter = () => {
    if (chatCounter) chatCounter.textContent = `${Array.from(chatInput?.value ?? "").length}/${MAX_GAME_CHAT_LENGTH}`;
  };
  chatInput?.addEventListener("input", updateChatCounter);
  chatForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem("message") as HTMLInputElement;
    const value = input.value.trim();
    if (!value) return;
    if (Array.from(value).length > MAX_GAME_CHAT_LENGTH) {
      toast(`El mensaje no puede superar ${MAX_GAME_CHAT_LENGTH} caracteres.`, "error");
      return;
    }
    input.value = "";
    updateChatCounter();
    if (!(await sendChatMessage(value, "text"))) {
      input.value = value;
      updateChatCounter();
    }
  });
  root.querySelectorAll<HTMLButtonElement>("[data-chat-emoji]").forEach((button) => {
    button.addEventListener("click", async () => {
      const emoji = button.dataset.chatEmoji;
      if (!emoji || button.disabled) return;
      button.disabled = true;
      try { await sendChatMessage(emoji, "emoji"); }
      finally { button.disabled = false; }
    });
  });

  void api.messages(game.id).then((response) => {
    const loadedIds = new Set(response.messages.map((message) => message.id));
    messages = [...response.messages, ...messages.filter((message) => !loadedIds.has(message.id))];
    messagesBeforeId = response.nextBeforeId;
    messagesHaveMore = response.hasMore;
    renderMessages();
  }).catch(() => {});
  const socketGameUpdate = (next: Game) => { if (String(next.id) === game.id) update({ ...next, playerColor: ownSide }); };
  const socketMessage = (message: ChatMessage) => addLiveMessage(message);
  const socketSpectatorUpdate = (payload: { gameId: string; count: number }) => {
    if (String(payload.gameId) !== game.id) return;
    const count = Math.max(Number(payload.count) || 0, 0);
    const element = root.querySelector<HTMLElement>("[data-player-spectator-count]");
    if (element) element.textContent = String(count);
  };
  socket?.emit("game:join", game.id, (result: { spectatorCount?: number }) => {
    socketSpectatorUpdate({
      gameId: game.id,
      count: result?.spectatorCount || 0,
    });
  });
  socket?.on("game:state", socketGameUpdate);
  socket?.on("game:updated", socketGameUpdate);
  socket?.on("game:message", socketMessage);
  socket?.on("game:spectators", socketSpectatorUpdate);
  clockTimer = window.setInterval(refreshClocks, 250);
  syncTimer = window.setInterval(() => void api.game(game.id).then((response) => update(response.game)).catch(() => {}), 10_000);
  startBackgroundSound();
  update(game);

  pageCleanup?.();
  pageCleanup = () => {
    if (pageLeaveGuard === leaveGuard) pageLeaveGuard = null;
    window.removeEventListener("beforeunload", handleBeforeUnload);
    board?.destroy();
    window.clearInterval(clockTimer);
    window.clearInterval(syncTimer);
    window.clearInterval(rematchTimer);
    Object.values(chatCloudTimers).forEach((timer) => {
      if (timer) window.clearTimeout(timer);
    });
    if (sentRematchId) void api.cancelInvitation(sentRematchId).catch(() => {});
    socket?.emit("game:leave", game.id);
    socket?.off("game:state", socketGameUpdate);
    socket?.off("game:updated", socketGameUpdate);
    socket?.off("game:message", socketMessage);
    socket?.off("game:spectators", socketSpectatorUpdate);
    stopBackgroundSound();
  };
}

function playerLiveData(side: Side, rating: number, pieces: number, time = "--:--") {
  return `<span class="player-numbers" aria-label="${rating} de Elo Damas, ${pieces} fichas y ${time} de tiempo"><b>${rating}</b><i>–</i><b data-piece-count="${side}">${pieces}</b><i>–</i><time class="game-clock" data-clock="${side}">${time}</time></span>`;
}

function pieceColorOptionsMarkup(selected: PieceColor) {
  return PIECE_COLOR_OPTIONS.map((option) => (
    `<option value="${option.key}" ${option.key === selected ? "selected" : ""}>${option.label}</option>`
  )).join("");
}

function pieceColorControlsPreferences(): PieceColorPreferences {
  const fallback = pieceColorPreferences();
  return {
    own: (root.querySelector<HTMLSelectElement>("[data-piece-color=own]")
      ?.value as PieceColor | undefined) || fallback.own,
    opponent: (root.querySelector<HTMLSelectElement>("[data-piece-color=opponent]")
      ?.value as PieceColor | undefined) || fallback.opponent,
  };
}

function syncGamePieceColorControls(preferences: PieceColorPreferences) {
  root.querySelectorAll<HTMLSelectElement>("[data-piece-color]").forEach((select) => {
    const role = select.dataset.pieceColor as PieceColorRole;
    select.value = preferences[role];
    const option = PIECE_COLOR_OPTIONS.find((item) => item.key === preferences[role]);
    root.querySelector<HTMLElement>(`[data-piece-color-swatch="${role}"]`)
      ?.style.setProperty("--piece-swatch", option?.value || "transparent");
  });
}

function gameQuickActions(
  chatAvailable = true,
  pieceColors = pieceColorPreferences(),
) {
  const sounds = soundPreferences();
  const backgroundVolume = Math.round(sounds.backgroundVolume * 100);
  const ownColor = PIECE_COLOR_OPTIONS.find((option) => option.key === pieceColors.own)!;
  const opponentColor = PIECE_COLOR_OPTIONS.find((option) => option.key === pieceColors.opponent)!;
  return `<div class="player-quick-actions">
    <button class="quick-action" type="button" data-quick-chat aria-label="Abrir chat" ${chatAvailable ? "" : "disabled"}>${icon("chat")}</button>
    <button class="quick-action" type="button" data-settings-toggle aria-label="Abrir configuración" aria-expanded="false">${icon("settings")}</button>
    <div class="game-settings-menu" data-settings-menu aria-hidden="true">
      <div class="settings-menu-title"><span>${icon("settings")}</span><b>Configuración</b><button type="button" data-settings-close aria-label="Cerrar configuración">×</button></div>
      <button type="button" data-settings-draw ${chatAvailable ? "" : "disabled"}><span>½</span><b>Tablas</b></button>
      <button type="button" data-settings-resign class="is-danger"><span>⚑</span><b>Rendirse</b></button>
      <div class="settings-color-section">
        <span class="settings-color-title"><i>●</i><b>Colores de fichas</b></span>
        <div class="settings-color-fields">
          <label><span><i data-piece-color-swatch="own" style="--piece-swatch:${ownColor.value}"></i>Tus fichas</span><select data-piece-color="own" aria-label="Color de tus fichas">${pieceColorOptionsMarkup(pieceColors.own)}</select></label>
          <label><span><i data-piece-color-swatch="opponent" style="--piece-swatch:${opponentColor.value}"></i>Rival</span><select data-piece-color="opponent" aria-label="Color de las fichas del rival">${pieceColorOptionsMarkup(pieceColors.opponent)}</select></label>
        </div>
        <small>Los dos lados siempre usan colores diferentes.</small>
      </div>
      <div class="settings-toggle-row"><span>${icon("volume")}<b>Movimientos y capturas</b></span><button type="button" role="switch" aria-label="Sonidos de movimientos y capturas" aria-checked="${sounds.moves}" class="mini-switch ${sounds.moves ? "is-on" : ""}" data-move-sound><i></i></button></div>
      <div class="settings-toggle-row"><span><i class="settings-symbol">♫</i><b>Música de fondo</b></span><button type="button" role="switch" aria-label="Música de fondo" aria-checked="${sounds.background}" class="mini-switch ${sounds.background ? "is-on" : ""}" data-background-sound><i></i></button></div>
      <label class="settings-volume-row"><span><i>♪</i><b>Volumen</b></span><span class="volume-slider"><input type="range" min="0" max="100" step="5" value="${backgroundVolume}" aria-label="Volumen de la música de fondo" data-background-volume style="--volume-progress:${backgroundVolume}%" /><output data-background-volume-output>${backgroundVolume}%</output></span></label>
      <button type="button" data-settings-new><span>${icon("refresh")}</span><b>Nueva partida</b></button>
    </div>
  </div>`;
}

function bindGameSettings(actions: {
  onChat?: () => void;
  onDraw?: () => void | Promise<void>;
  onPieceColorsChange?: (preferences: PieceColorPreferences) => void | Promise<void>;
  onResign: () => void | Promise<void>;
  onNewGame: () => void | Promise<void>;
}) {
  const menu = root.querySelector<HTMLElement>("[data-settings-menu]");
  const toggle = root.querySelector<HTMLButtonElement>("[data-settings-toggle]");
  const sidebar = root.querySelector<HTMLElement>(".game-sidebar");
  const gamePage = root.querySelector<HTMLElement>(".game-page");
  if (menu && sidebar) sidebar.append(menu);
  const closeMenu = () => {
    menu?.classList.remove("is-open");
    menu?.setAttribute("aria-hidden", "true");
    toggle?.setAttribute("aria-expanded", "false");
    toggle?.setAttribute("aria-label", "Abrir configuración");
    sidebar?.classList.remove("is-settings-visible");
  };
  toggle?.addEventListener("click", () => {
    const open = !menu?.classList.contains("is-open");
    menu?.classList.toggle("is-open", open);
    menu?.setAttribute("aria-hidden", String(!open));
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Cerrar configuración" : "Abrir configuración");
    sidebar?.classList.toggle("is-settings-visible", open);
  });
  menu?.querySelector("[data-settings-close]")?.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
  });
  gamePage?.addEventListener("pointerdown", (event) => {
    if (!menu?.classList.contains("is-open")) return;
    const target = event.target as Node;
    if (menu.contains(target) || toggle?.contains(target)) return;
    closeMenu();
  }, { capture: true });
  root.querySelectorAll<HTMLElement>(".board-shell").forEach((boardShell) => {
    boardShell.addEventListener("pointerdown", closeMenu, { capture: true });
  });
  root.querySelector<HTMLButtonElement>("[data-quick-chat]")?.addEventListener("click", () => {
    closeMenu();
    actions.onChat?.();
  });
  root.querySelector("[data-settings-draw]")?.addEventListener("click", () => {
    closeMenu();
    void actions.onDraw?.();
  });
  root.querySelector("[data-settings-resign]")?.addEventListener("click", () => {
    closeMenu();
    void actions.onResign();
  });
  root.querySelector("[data-settings-new]")?.addEventListener("click", () => {
    closeMenu();
    void actions.onNewGame();
  });
  root.querySelectorAll<HTMLSelectElement>("[data-piece-color]").forEach((select) => {
    select.addEventListener("change", () => {
      const role = select.dataset.pieceColor as PieceColorRole;
      const current = pieceColorControlsPreferences();
      const preferences = setPieceColorPreference(
        role,
        select.value as PieceColor,
        current,
      );
      syncGamePieceColorControls(preferences);
      void actions.onPieceColorsChange?.(preferences);
    });
  });
  const updateSwitch = (button: HTMLButtonElement, enabled: boolean) => {
    button.classList.toggle("is-on", enabled);
    button.setAttribute("aria-checked", String(enabled));
  };
  root.querySelector<HTMLButtonElement>("[data-move-sound]")?.addEventListener("click", (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const enabled = button.getAttribute("aria-checked") !== "true";
    setMoveSound(enabled);
    updateSwitch(button, enabled);
  });
  root.querySelector<HTMLButtonElement>("[data-background-sound]")?.addEventListener("click", (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const enabled = button.getAttribute("aria-checked") !== "true";
    setBackgroundSound(enabled);
    updateSwitch(button, enabled);
  });
  root.querySelector<HTMLInputElement>("[data-background-volume]")?.addEventListener("input", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const percentage = Number(input.value);
    setBackgroundVolume(percentage / 100);
    input.style.setProperty("--volume-progress", `${percentage}%`);
    const output = root.querySelector<HTMLOutputElement>("[data-background-volume-output]");
    if (output) output.value = `${percentage}%`;
  });
  return closeMenu;
}

function playerBar(
  player: Game["players"][Side],
  side: Side,
  placement: string,
  pieces: number,
  pieceColors = pieceColorPreferences(),
) {
  return `<div class="player-bar player-bar--${placement}" data-player-bar="${side}">
    ${playerProfileButton(player, `${placement === "own" ? `<span class="avatar-slot" data-current-user-avatar data-avatar-class="avatar avatar--player">${avatarMarkup(player, "avatar avatar--player")}</span>` : avatarMarkup(player, "avatar avatar--player")}<span><span class="player-name-line"><i title="${escapeHtml(player.countryCode)}">${flag(player.countryCode)}</i><b>${escapeHtml(player.name)} ${placement === "own" ? "(Tú)" : ""}</b>${worldTrophyMarkup(player, "world-trophy--game")}</span><small>@${escapeHtml(player.username)}</small></span>`, "player-identity")}
    ${playerLiveData(side, player.rating.rating, pieces)}
    <div class="turn-indicator"><i></i><span>Jugando</span></div>
    ${placement === "own" ? gameQuickActions(true, pieceColors) : ""}
    <div class="player-chat-cloud" data-chat-cloud="${side}" aria-live="polite" aria-hidden="true"><small></small><p></p></div>
  </div>`;
}

function endReasonLabel(reason: string | null) {
  const labels: Record<string, string> = {
    board: "La posición decidió la partida.",
    resignation: "La partida terminó por rendición.",
    timeout: "El reloj decidió la partida.",
    draw: "Ambos jugadores acordaron tablas.",
    withdrawal: "La partida terminó antes de la primera jugada.",
  };
  return labels[reason ?? ""] ?? "La partida ha concluido.";
}

function formatDuration(totalSeconds: number) {
  const safe = Math.max(0, totalSeconds);
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

async function connectRealtime() {
  const { io } = await (socketIoPromise ??= import("socket.io-client"));
  if (!currentUser) return;
  socket?.disconnect();
  socket = io(SOCKET_URL, { withCredentials: true, transports: ["websocket"] });
  socket.on("matchmaking:matched", (game: Game) => {
    if (matchmakingTimer) void stopMatchmaking(false);
    navigate(`/partida/${game.id}`);
  });
  socket.on("invitation:updated", () => {
    void checkIncomingChallenges();
  });
  socket.on("connect_error", (error) => {
    console.warn("La conexión en vivo no está disponible; se usará una actualización alternativa.", error.message);
  });
}

function scheduleBackgroundServices(user: User, delay = 0) {
  window.requestAnimationFrame(() => {
    window.setTimeout(() => {
      if (currentUser?.id !== user.id) return;
      void connectRealtime().catch((error) => {
        console.warn("La conexión en vivo se completará en segundo plano.", error);
      });
      void initializeNativeStoreForUser(user);
    }, delay);
  });
}

function setSessionHint(active: boolean) {
  try {
    if (active) localStorage.setItem(SESSION_HINT_KEY, "1");
    else localStorage.removeItem(SESSION_HINT_KEY);
  } catch {
    // La sesión HTTP continúa funcionando aunque el almacenamiento esté bloqueado.
  }
}

async function renderRoute() {
  const path = route();
  renderedPath = path;
  pageCleanup?.();
  pageCleanup = null;
  stopLinkInvitationPolling();
  if (isPasswordResetPath()) return renderPasswordReset(passwordResetToken());
  const sharedInvitation = new URLSearchParams(window.location.search).get("invitacion");
  if (sharedInvitation) return renderSharedInvitation(sharedInvitation);
  if (path === "/como-jugar") return renderHowToPlay();
  if (isLegalPath(path)) return renderLegalPage(path);
  if (!currentUser) {
    void hideNativeAdBanner();
    renderLanding();
    return;
  }
  const isPlayingBoard = /^\/leyenda\/[a-z]+\/(10|30|60)$/.test(path) || /^\/partida\/\d+$/.test(path);
  if (isIOSNativeApp()) {
    void (isPlayingBoard ? hideNativeAdBanner() : showNativeAdBanner());
    document.documentElement.classList.toggle("ad-banner-active", !isPlayingBoard);
  }
  const profileMatch = path.match(/^\/perfil\/([a-z0-9_]{3,24})$/i);
  if (profileMatch?.[1]) return renderPlayerProfile(profileMatch[1].toLowerCase());
  if (path === "/clasificacion") return renderLeaderboard();
  if (path === "/comunidad") return renderCommunity();
  if (path === "/torneos") return renderTournaments();
  if (path === "/donar") return renderDonation();
  if (path === "/creditos") return renderCredits();
  if (path === "/informacion") return renderInformationHub();
  if (path === "/en-vivo") return renderLiveGames();
  if (path === "/jugar") return renderPlayPage();
  const legendRoadMatch = path.match(/^\/leyendas\/(10|30|60)$/);
  if (legendRoadMatch?.[1]) return renderLegendRoadmap(Number(legendRoadMatch[1]) as TimeControl);
  const legacyLegendMatch = path.match(/^\/leyenda\/(10|30|60)$/);
  if (legacyLegendMatch?.[1]) return navigate(`/leyendas/${legacyLegendMatch[1]}`);
  const legendMatch = path.match(/^\/leyenda\/([a-z]+)\/(10|30|60)$/);
  if (legendMatch?.[1] && legendMatch[2] && legendByKey(legendMatch[1])) {
    return renderLegendGame(
      Number(legendMatch[2]) as TimeControl,
      legendMatch[1] as LegendDifficultyKey,
    );
  }
  const gameMatch = path.match(/^\/partida\/(\d+)$/);
  if (gameMatch?.[1]) return renderGame(gameMatch[1]);
  const spectatorMatch = path.match(/^\/espectar\/(\d+)$/);
  if (spectatorMatch?.[1]) return renderSpectatorGame(spectatorMatch[1]);
  return renderDashboard();
}

let routeListenerBound = false;
let playerProfileListenerBound = false;

function bindPlayerProfileNavigation() {
  if (playerProfileListenerBound) return;
  root.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-player-profile-link]",
    );
    const username = target?.dataset.playerProfileLink;
    if (!username) return;
    event.preventDefault();
    event.stopPropagation();
    navigate(`/perfil/${encodeURIComponent(username)}`);
  });
  playerProfileListenerBound = true;
}

async function handleHashChange() {
  if (bypassNextHashGuard) {
    bypassNextHashGuard = false;
    await renderRoute();
    if (currentUser) void checkIncomingChallenges();
    return;
  }
  if (route() !== renderedPath && !(await requestPageLeave())) {
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${location.search}#${renderedPath}`,
    );
    return;
  }
  await renderRoute();
  if (currentUser) void checkIncomingChallenges();
}

async function handleAppLanguageChange(event: Event) {
  const language = (event as CustomEvent<{ language?: AppLanguage }>).detail
    ?.language;
  if (!language || !currentUser) return;
  currentUser = { ...currentUser, language };
  const rendering = renderRoute();
  const saving = languageSaveQueue.then(async () => {
    await api.updateLanguage(language);
  });
  languageSaveQueue = saving.catch(() => {});
  try {
    await saving;
  } catch (error) {
    console.warn("No se pudo guardar la preferencia de idioma.", error);
    toast(
      "El idioma cambió en este dispositivo, pero no pudimos guardarlo en tu cuenta.",
      "error",
    );
  }
  await rendering;
}

export async function startApp(user: User | null) {
  if (user?.language) useUserLanguage(user.language);
  currentUser = user;
  applyPremiumStatus(Boolean(user?.premium?.active), user?.premium?.expiresAt || null);
  bindPlayerProfileNavigation();
  if (!routeListenerBound) {
    window.addEventListener("hashchange", () => void handleHashChange());
    routeListenerBound = true;
  }
  if (!languageListenerBound) {
    window.addEventListener(LANGUAGE_CHANGE_EVENT, (event) => {
      void handleAppLanguageChange(event);
    });
    languageListenerBound = true;
  }
  if (currentUser) {
    setSessionHint(true);
    const currentPath = route();
    const activeGameRequest = /^\/partida\/\d+$/.test(currentPath)
      ? Promise.resolve(null)
      : api.activeGame()
        .then((response) => response.game)
        .catch((error) => {
          console.warn("No se pudo comprobar la partida activa.", error);
          return null;
        });
    const activeGame = await activeGameRequest;
    if (activeGame?.status === "active") {
      const activePath = `/partida/${activeGame.id}`;
      history.replaceState(
        history.state,
        "",
        `${location.pathname}${location.search}#${activePath}`,
      );
    }
  }
  await renderRoute();
  if (currentUser) {
    scheduleBackgroundServices(currentUser);
    void checkIncomingChallenges();
  }
}
