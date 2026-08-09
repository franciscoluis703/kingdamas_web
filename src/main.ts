import type { Socket } from "socket.io-client";
import "./styles.css";
import { api, ApiError } from "./api";
import { PUBLIC_APP_URL, SOCKET_URL, TIME_CONTROLS, type TimeControl } from "./config";
import { ELO_TIERS, eloTier, eloTierRange } from "./eloTiers";
import { CmCheckersboard } from "./game/CmCheckersboard";
import { applyMove, countPieces, createInitialBoard, getWinner, moveNotation, opponentOf } from "./game/engine";
import { spectatorClockValue } from "./game/spectators";
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

const LEGAL_CONSENT_VERSION = "2026-08-09";
const SESSION_HINT_KEY = "kingdamas_session_hint";
const LEGAL_ROUTES = [
  { path: "/acerca-de", label: "Acerca de", shortLabel: "Acerca de" },
  { path: "/contacto", label: "Contacto", shortLabel: "Contacto" },
  { path: "/politica-de-cookies", label: "Política de cookies", shortLabel: "Cookies" },
  { path: "/terminos-y-condiciones", label: "Términos y condiciones", shortLabel: "Términos" },
  { path: "/politica-de-privacidad", label: "Política de privacidad", shortLabel: "Privacidad" },
] as const;
type LegalPath = (typeof LEGAL_ROUTES)[number]["path"];

const route = () => location.hash.replace(/^#/, "") || "/inicio";
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
  return `<span class="brand-mark"><img src="/favicon-64.png?v=green-1" width="64" height="64" alt="" /></span>`;
}

function logoMarkup() {
  return `${brandMarkMarkup()}<span class="brand-name">King <b>Damas</b></span>`;
}

function publicHeader() {
  return `
    <header class="public-header container">
      <button class="brand brand--button" type="button" data-route="/inicio" aria-label="Ir al inicio">${logoMarkup()}</button>
      <nav class="public-nav" aria-label="Navegación principal">
        <a href="#como-jugar">Cómo jugar</a>
        <button class="button button--quiet" type="button" data-open-auth="login">Entrar</button>
        <button class="button button--primary button--small" type="button" data-open-auth="register">Crear cuenta</button>
      </nav>
    </header>`;
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
          <span><small>APOYA EL PROYECTO</small><b>Donar</b></span>
          <i aria-hidden="true">→</i>
        </button>
        <button class="sidebar-credits ${active === "credits" ? "is-active" : ""}" type="button" data-route="/creditos"><span class="sidebar-credits-icon">©</span><span><b>Créditos</b><small>Autores y licencias</small></span><i aria-hidden="true">→</i></button>
        <button class="nav-item nav-item--logout" data-logout>${icon("logout")}<span>Cerrar sesión</span></button>
      </aside>
      <div class="app-stage">
        <header class="app-header">
          <button class="icon-button mobile-menu" type="button" data-menu aria-label="Abrir menú">${icon("menu")}</button>
          <button class="mobile-brand brand brand--button" type="button" data-route="/inicio">${logoMarkup()}</button>
          <button class="account-chip" type="button" data-open-profile-photo aria-label="Cambiar foto de perfil">
            <span class="avatar-slot" data-current-user-avatar data-avatar-class="avatar avatar--small">${avatar}</span>
            <span class="account-copy"><b>${escapeHtml(currentUser.name)}</b><small>@${escapeHtml(currentUser.username)}</small></span>
            <span class="account-camera" aria-hidden="true">${icon("camera")}</span>
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
              <span><b>En vivo</b><small>Con Socket.IO</small></span>
            </div>
          </div>
          <div class="hero-board-wrap" aria-hidden="true">
            <div class="hero-glow"></div>
            <div class="mini-board">${decorativeBoard()}</div>
            <div class="floating-card floating-card--rating"><span>${icon("ranking")}</span><small>Elo Damas</small><b>1,428 <i>+18</i></b></div>
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
      </main>
      <footer class="public-footer container"><span>© ${new Date().getFullYear()} King Damas</span><span>Hecho para quienes piensan dos jugadas adelante.</span></footer>
      ${authDialogMarkup()}
    </div>`;
  bindNavigation();
  bindAuthDialog();
}

function decorativeBoard() {
  return Array.from({ length: 100 }, (_, index) => {
    const row = Math.floor(index / 10);
    const col = index % 10;
    const dark = (row + col) % 2 === 1;
    const ivory = dark && row < 4;
    const mahogany = dark && row > 5;
    return `<span class="mini-square ${dark ? "is-dark" : ""}">${ivory || mahogany ? `<i class="mini-piece ${ivory ? "is-ivory" : "is-mahogany"}"></i>` : ""}</span>`;
  }).join("");
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
        <p class="form-error" aria-live="polite"></p>
        <button class="button button--primary button--wide" type="submit">Entrar a la mesa</button>
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
  const setTab = (tab: "login" | "register") => {
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
  dialog.querySelectorAll<HTMLFormElement>(".auth-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = form.querySelector<HTMLButtonElement>("[type=submit]");
      const error = form.querySelector<HTMLElement>(".form-error");
      const data = new FormData(form);
      if (submit) { submit.disabled = true; submit.textContent = "Entrando…"; }
      if (error) error.textContent = "";
      try {
        const response = form.dataset.authForm === "login"
          ? await api.login(String(data.get("identifier")), String(data.get("password")))
          : await api.register({
              name: String(data.get("name")),
              username: String(data.get("username")),
              email: String(data.get("email")),
              countryCode: String(data.get("countryCode")),
              password: String(data.get("password")),
            });
        currentUser = response.user;
        setSessionHint(true);
        dialog.close();
        await connectRealtime();
        navigate("/inicio");
        toast(`Bienvenido, ${currentUser.name}.`);
      } catch (requestError) {
        if (error) error.textContent = errorMessage(requestError);
      } finally {
        if (submit) {
          submit.disabled = false;
          submit.textContent = form.dataset.authForm === "login" ? "Entrar a la mesa" : "Crear mi cuenta";
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
      <div><span class="eyebrow"><i></i>RESUMEN PERSONAL</span><h1>Hola, ${escapeHtml(currentUser?.name.split(" ")[0])}</h1><p>Este es tu recorrido actual en Elo Damas.</p></div>
      <div class="rating-card"><span>${icon("ranking")}</span><div><small>Tu Elo Damas</small><b>${value.toLocaleString("es-DO")}</b><em>${escapeHtml(rating?.tier ?? eloTier(value))}</em></div></div>
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
      <div class="rating-card"><span>${icon("ranking")}</span><div><small>Competirás con</small><b>${value.toLocaleString("es-DO")}</b><em>${escapeHtml(rating?.tier ?? eloTier(value))}</em></div></div>
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
      <label class="share-link-field"><span>Enlace de invitación</span><span><input readonly data-invite-url aria-label="Enlace de invitación" /><button type="button" data-copy-invite aria-label="Copiar enlace">${icon("copy")}</button></span></label>
      <div class="invite-actions"><button class="button button--primary" type="button" data-share-invite>${icon("share")} Compartir</button><button class="button button--quiet" type="button" data-copy-invite-text>${icon("copy")} Copiar enlace</button></div>
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
        <img src="/brand/icon-192.png?v=green-1" alt="" />
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

async function renderDonation() {
  root.innerHTML = appLayout(loadingMarkup("Preparando el espacio de donación…"), "donate");
  bindNavigation();
  try {
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
      <div><span class="eyebrow"><i></i>PERSONAS DETRÁS DEL SONIDO</span><h1>Créditos</h1><p>Reconocemos a quienes aportaron la música y los efectos que acompañan cada decisión sobre el tablero.</p></div>
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
    </section>
    <section class="credits-thanks"><span>${brandMarkMarkup()}</span><div><small>GRACIAS POR COMPARTIR SU TRABAJO</small><h2>Su creatividad también forma parte de cada partida.</h2><p>Los enlaces de autor y las licencias permanecen disponibles aquí y dentro de la configuración de sonido.</p></div></section>
  `, "credits");
  bindNavigation();
}

function isLegalPath(path: string): path is LegalPath {
  return LEGAL_ROUTES.some((item) => item.path === path);
}

function renderInformationHub() {
  const descriptions: Record<LegalPath, string> = {
    "/acerca-de": "Conoce el propósito, los principios y la tecnología de King Damas.",
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

function termsConsentMarkup() {
  const acceptedAt = legalConsentAcceptedAt();
  if (acceptedAt) {
    const date = new Date(acceptedAt).toLocaleString("es-DO", {
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
    <section><h2>Nuestros principios</h2><p>Buscamos una mesa respetuosa, reglas transparentes, resultados trazables y mejoras continuas. El juego limpio y el trato digno entre jugadores están por encima de cualquier clasificación.</p></section>
    <section><h2>Tecnología</h2><p>La plataforma utiliza TypeScript en la experiencia web y un backend en Node.js con Express, Socket.IO, MySQL y Redis para mantener partidas y comunicaciones en tiempo real.</p></section>`;
}

function legalContactMarkup() {
  return `<div class="legal-contact-card"><span>${icon("send")}</span><div><small>CANAL PRINCIPAL</small><h2>admin@kingdamas.com</h2><p>Escríbenos desde tu correo e incluye tu nombre de usuario si la consulta se relaciona con tu cuenta.</p></div><a class="button button--primary" href="mailto:admin@kingdamas.com?subject=Contacto%20King%20Damas">Escribir correo</a></div>
    <section><h2>¿En qué podemos ayudarte?</h2><div class="legal-feature-grid"><span><b>Cuenta y soporte</b><small>Acceso, perfil, partidas o errores técnicos.</small></span><span><b>Privacidad</b><small>Acceso, corrección o eliminación de tus datos personales.</small></span><span><b>Convivencia</b><small>Reportes de conducta, suplantación o uso indebido de la plataforma.</small></span></div></section>
    <section><h2>Para responder mejor</h2><p>No envíes contraseñas, datos bancarios ni códigos de acceso. Describe lo ocurrido, indica la fecha aproximada y, si corresponde, el número de partida o torneo. Procuraremos responder tan pronto como sea razonablemente posible.</p></section>
    <aside class="legal-note"><b>Seguridad de pagos</b><p>Las donaciones y pagos habilitados se procesan mediante proveedores externos. King Damas nunca te pedirá por correo la contraseña de tu cuenta ni los datos completos de una tarjeta.</p></aside>`;
}

function legalCookiesMarkup() {
  return `<aside class="legal-note legal-note--green"><b>Uso actual</b><p>King Damas no utiliza cookies publicitarias ni de seguimiento. Solo emplea tecnología esencial para mantener la sesión y preferencias locales para personalizar el juego.</p></aside>
    <section><h2>Cookies y almacenamiento utilizados</h2><div class="legal-data-table"><div><b>king_damas_session</b><span>Cookie esencial</span><p>Mantiene la sesión iniciada y protege el acceso a la cuenta. Se envía de forma segura al backend.</p></div><div><b>Preferencias de sonido</b><span>Almacenamiento local</span><p>Recuerda música, efectos y volumen elegidos en este navegador.</p></div><div><b>Consentimiento legal</b><span>Almacenamiento local</span><p>Evita pedir nuevamente la misma aceptación a la misma cuenta en este navegador.</p></div></div></section>
    <section><h2>Servicios externos</h2><p>La biblioteca de PayPal se carga únicamente cuando visitas la sección de donaciones y dicha empresa puede utilizar sus propias tecnologías conforme a sus políticas. Los audios, el tablero y los recursos visuales se sirven desde King Damas.</p></section>
    <section><h2>Cómo controlarlas</h2><p>Puedes borrar cookies y datos locales desde la configuración del navegador. Si eliminas la cookie de sesión, tendrás que iniciar sesión nuevamente; si eliminas las preferencias, se restaurarán sus valores predeterminados.</p></section>
    <section><h2>Cambios</h2><p>Si en el futuro se incorporan cookies analíticas, publicitarias o cualquier uso no esencial, esta política se actualizará y se solicitará la elección correspondiente antes de activarlas.</p></section>`;
}

function legalTermsMarkup() {
  return `${termsConsentMarkup()}
    <section><h2>1. Aceptación y cuenta</h2><p>Al crear o utilizar una cuenta confirmas que puedes aceptar estas condiciones. Si eres menor de edad, debes contar con autorización y supervisión de tu padre, madre o tutor legal. Debes proporcionar información válida, proteger tus credenciales y responder por la actividad de tu cuenta.</p></section>
    <section><h2>2. Uso permitido</h2><p>King Damas está destinado al juego de damas internacionales 10×10, la interacción comunitaria y la participación en actividades anunciadas. No puedes automatizar partidas, manipular resultados o Elo, explotar fallos, suplantar a otra persona, acosar, amenazar ni publicar contenido ilícito.</p></section>
    <section><h2>3. Juego limpio y moderación</h2><p>Podemos investigar conductas irregulares y aplicar advertencias, anular resultados, limitar funciones o suspender cuentas cuando sea necesario para proteger a la comunidad. Las decisiones competitivas podrán revisarse cuando exista evidencia suficiente.</p></section>
    <section><h2>4. Elo Damas, torneos y pagos</h2><p>El Elo Damas es una medida interna de rendimiento y no tiene valor monetario. Cada torneo puede tener bases adicionales, fechas, requisitos y premios publicados en su ficha. Las donaciones son voluntarias y no conceden ventajas competitivas. Los pagos habilitados son procesados por proveedores externos.</p></section>
    <section><h2>5. Disponibilidad y cambios</h2><p>Trabajamos para ofrecer un servicio estable, pero no garantizamos funcionamiento ininterrumpido. Podemos realizar mantenimiento, corregir resultados afectados por errores técnicos y actualizar funciones o estas condiciones. Los cambios importantes serán comunicados dentro de la plataforma y podrán requerir una nueva aceptación.</p></section>
    <section><h2>6. Responsabilidad</h2><p>La plataforma se ofrece según su disponibilidad. En la medida permitida por la ley aplicable, King Damas no responde por interrupciones ajenas a su control, pérdidas indirectas ni decisiones tomadas con base en una clasificación provisional.</p></section>
    <section><h2>7. Legislación y contacto</h2><p>Estas condiciones se interpretan conforme a las leyes aplicables de la República Dominicana. Para preguntas o reclamaciones, escribe a <a href="mailto:admin@kingdamas.com">admin@kingdamas.com</a>. Puedes consultar como referencia la <a href="https://dgii.gov.do/legislacion/leyesTributarias/Documents/Otras%20Leyes%20de%20Inter%C3%A9s/126-02.pdf" target="_blank" rel="noreferrer">Ley 126-02 sobre comercio electrónico y documentos digitales ↗</a>.</p></section>`;
}

function legalPrivacyMarkup() {
  return `<aside class="legal-note legal-note--green"><b>Compromiso de privacidad</b><p>Usamos los datos necesarios para operar la cuenta, las partidas y la comunidad. No vendemos información personal.</p></aside>
    <section><h2>1. Datos que tratamos</h2><p>Podemos tratar nombre, usuario, correo, país, foto de perfil, contraseña protegida mediante hash, historial de acceso, partidas, Elo Damas, amistades, mensajes, inscripciones a torneos, referencias de transacciones y datos técnicos necesarios para seguridad y diagnóstico.</p></section>
    <section><h2>2. Para qué los utilizamos</h2><p>Los usamos para autenticarte, operar partidas en tiempo real, calcular clasificaciones, mostrar tu perfil, facilitar funciones comunitarias, gestionar torneos y pagos, atender solicitudes, prevenir abuso y mantener la seguridad y estabilidad del servicio.</p></section>
    <section><h2>3. Información visible</h2><p>Tu nombre, usuario, país, foto, rango, Elo Damas y actividad competitiva pueden mostrarse a otros usuarios. El correo, la contraseña y los datos privados de soporte no se publican. Los mensajes se muestran únicamente a sus participantes, salvo revisión necesaria por seguridad o cumplimiento.</p></section>
    <section><h2>4. Proveedores y transferencias</h2><p>Podemos utilizar proveedores de alojamiento, base de datos, caché, correo y pagos para prestar el servicio. Algunos pueden procesar información fuera de la República Dominicana. Solo se comparte lo necesario para su función o cuando exista una obligación legal válida.</p></section>
    <section><h2>5. Conservación y seguridad</h2><p>Conservamos la información mientras la cuenta esté activa y durante el tiempo adicional razonablemente necesario para seguridad, resolución de disputas y obligaciones legales. Aplicamos controles técnicos y organizativos, aunque ningún sistema conectado a internet puede garantizar riesgo cero.</p></section>
    <section><h2>6. Tus derechos</h2><p>Puedes solicitar acceso, corrección, actualización o eliminación de tus datos, sujeto a las excepciones legales y registros que debamos conservar. Envía la solicitud desde el correo asociado a tu cuenta a <a href="mailto:admin@kingdamas.com?subject=Solicitud%20de%20privacidad%20King%20Damas">admin@kingdamas.com</a>.</p></section>
    <section><h2>7. Marco y actualizaciones</h2><p>Esta política toma como referencia la protección de datos aplicable en la República Dominicana, incluida la <a href="https://presidencia.gob.do/sites/default/files/statics/transparencia/marco-legal/leyes/Ley-172-13.pdf" target="_blank" rel="noreferrer">Ley 172-13 sobre Protección de Datos Personales ↗</a>. Informaremos cambios relevantes y solicitaremos una nueva confirmación cuando corresponda.</p></section>`;
}

function legalPageMarkup(path: LegalPath) {
  const pages: Record<LegalPath, { title: string; eyebrow: string; description: string; body: () => string }> = {
    "/acerca-de": { title: "Acerca de", eyebrow: "CONOCE KING DAMAS", description: "El propósito, la tecnología y los principios detrás de cada mesa.", body: legalAboutMarkup },
    "/contacto": { title: "Contacto", eyebrow: "ESTAMOS PARA AYUDAR", description: "Un canal claro para soporte, privacidad y asuntos de la comunidad.", body: legalContactMarkup },
    "/politica-de-cookies": { title: "Política de cookies", eyebrow: "CONTROL Y TRANSPARENCIA", description: "Qué guarda King Damas en tu navegador y para qué se utiliza.", body: legalCookiesMarkup },
    "/terminos-y-condiciones": { title: "Términos y condiciones", eyebrow: "REGLAS DE LA PLATAFORMA", description: "Las condiciones para usar King Damas y compartir una mesa justa.", body: legalTermsMarkup },
    "/politica-de-privacidad": { title: "Política de privacidad", eyebrow: "TUS DATOS, CON CLARIDAD", description: "Cómo recopilamos, utilizamos y protegemos tu información.", body: legalPrivacyMarkup },
  };
  const page = pages[path];
  return `<section class="page-heading legal-heading"><div><span class="eyebrow"><i></i>${page.eyebrow}</span><h1>${page.title}</h1><p>${page.description}</p></div><span class="legal-updated"><small>ÚLTIMA ACTUALIZACIÓN</small><b>9 ago 2026</b></span></section>
    <div class="legal-layout">
      <aside class="panel legal-page-menu"><small>INFORMACIÓN</small>${LEGAL_ROUTES.map((item, index) => `<button class="${item.path === path ? "is-active" : ""}" type="button" data-route="${item.path}"><i>${String(index + 1).padStart(2, "0")}</i><span>${item.shortLabel}</span><b aria-hidden="true">›</b></button>`).join("")}</aside>
      <article class="panel legal-document">${page.body()}<footer><span>${brandMarkMarkup()}</span><p><b>King Damas</b><small>Damas internacionales 10×10 · República Dominicana</small></p></footer></article>
    </div>`;
}

function renderLegalPage(path: LegalPath) {
  root.innerHTML = appLayout(legalPageMarkup(path), "legal");
  bindNavigation();
}

function communityPlayerMarkup(
  player: User & { rating?: number },
  isFriend: boolean,
  placement: "friends" | "discover",
) {
  return `<article class="community-player">
    ${avatarMarkup(player, "avatar avatar--community")}
    <span class="community-player-copy"><b>${escapeHtml(player.name)}</b><small>${flag(player.countryCode)} @${escapeHtml(player.username)}</small></span>
    ${player.rating !== undefined ? `<strong>${player.rating.toLocaleString("es-DO")}<small>Elo</small></strong>` : ""}
    <div class="community-player-actions">
      <button type="button" data-open-conversation="${escapeHtml(player.username)}" aria-label="Enviar mensaje a ${escapeHtml(player.name)}" title="Mensaje">${icon("chat")}</button>
      ${placement === "friends"
        ? `<button class="is-danger" type="button" data-remove-friend="${escapeHtml(player.username)}" aria-label="Eliminar a ${escapeHtml(player.name)} de tus amigos" title="Eliminar de amigos">×</button>`
        : `<button class="add-player ${isFriend ? "is-added" : ""}" type="button" ${isFriend ? "disabled" : `data-add-friend="${escapeHtml(player.username)}"`} aria-label="${isFriend ? "Ya está en tus amigos" : `Agregar a ${escapeHtml(player.name)}`}" title="${isFriend ? "Ya agregado" : "Agregar amigo"}">${isFriend ? "✓" : icon("userPlus")}</button>`}
    </div>
  </article>`;
}

function communityConversationMarkup(conversation: DirectConversation) {
  const when = new Date(conversation.lastMessageAt).toLocaleDateString("es-DO", {
    day: "2-digit",
    month: "short",
  });
  return `<button class="conversation-row" type="button" data-open-conversation="${escapeHtml(conversation.user.username)}">
    ${avatarMarkup(conversation.user, "avatar avatar--community")}
    <span><b>${escapeHtml(conversation.user.name)}</b><small>${conversation.lastMessageOwn ? "Tú: " : ""}${escapeHtml(conversation.lastMessage)}</small></span>
    <time>${escapeHtml(when)}</time>
    ${conversation.unreadCount ? `<i>${conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}</i>` : ""}
  </button>`;
}

function communityMarkup(
  friends: User[],
  discovery: LeaderboardPlayer[],
  conversations: DirectConversation[],
  totalPlayers: number,
  registeredUsers: number,
) {
  const friendNames = new Set(friends.map((friend) => friend.username));
  const visibleDiscovery = discovery.filter((player) => player.id !== currentUser?.id).slice(0, 8);
  return `
    <section class="page-heading community-heading">
      <div><span class="eyebrow"><i></i>JUGADORES DE KING DAMAS</span><h1>Comunidad</h1><span class="community-registered-count" aria-label="${registeredUsers.toLocaleString("es-DO")} usuarios registrados"><b>${registeredUsers.toLocaleString("es-DO")}</b></span><p>Encuentra rivales, crea tu círculo y mantén la conversación fuera del tablero.</p></div>
      <div class="community-stats"><span><b>${totalPlayers.toLocaleString("es-DO")}</b><small>Clasificados</small></span><span><b>${friends.length}</b><small>Amigos</small></span><span><b>${conversations.reduce((total, item) => total + item.unreadCount, 0)}</b><small>Sin leer</small></span></div>
    </section>
    <label class="community-search"><span>${icon("search")}</span><input type="search" autocomplete="off" minlength="2" maxlength="60" placeholder="Buscar por nombre o @usuario…" data-community-search /><kbd>Buscar</kbd></label>
    <div class="community-grid">
      <section class="panel community-panel community-friends">
        <div class="community-panel-heading"><span><small>TU CÍRCULO</small><h2>Amigos</h2></span><b>${friends.length}</b></div>
        <div class="community-player-list" data-friends-list>
          ${friends.length ? friends.map((player) => communityPlayerMarkup(player, true, "friends")).join("") : `<div class="community-empty"><span>${icon("users")}</span><b>Tu círculo comienza aquí</b><p>Busca jugadores y agrégalos para encontrarlos rápidamente.</p></div>`}
        </div>
      </section>
      <section class="panel community-panel community-discover">
        <div class="community-panel-heading"><span><small data-discovery-kicker>CLASIFICACIÓN MUNDIAL</small><h2 data-discovery-title>Descubrir jugadores</h2></span><span class="community-live"><i></i>Activa</span></div>
        <div class="community-player-list" data-discovery-list>
          ${visibleDiscovery.length ? visibleDiscovery.map((player) => communityPlayerMarkup(player, friendNames.has(player.username), "discover")).join("") : `<div class="community-empty"><span>${icon("search")}</span><b>No hay jugadores para mostrar</b><p>Usa la búsqueda para encontrar a alguien.</p></div>`}
        </div>
      </section>
      <section class="panel community-panel community-conversations">
        <div class="community-panel-heading"><span><small>MENSAJES PRIVADOS</small><h2>Conversaciones</h2></span>${conversations.some((item) => item.unreadCount) ? `<b>${conversations.reduce((total, item) => total + item.unreadCount, 0)} nuevos</b>` : ""}</div>
        <div class="conversation-list">
          ${conversations.length ? conversations.map(communityConversationMarkup).join("") : `<div class="community-empty community-empty--compact"><span>${icon("chat")}</span><b>Aún no hay mensajes</b><p>Abre una conversación desde cualquier jugador.</p></div>`}
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
      ),
      "community",
    );
    bindNavigation();
    bindCommunity(
      friendsResponse.users,
      leaderboardResponse.players,
    );
  } catch (error) {
    root.innerHTML = appLayout(errorState(errorMessage(error)), "community");
    bindNavigation();
    bindRetry(() => renderCommunity());
  }
}

function bindCommunity(friends: User[], initialDiscovery: LeaderboardPlayer[]) {
  const search = root.querySelector<HTMLInputElement>("[data-community-search]");
  const discoveryList = root.querySelector<HTMLElement>("[data-discovery-list]");
  const discoveryTitle = root.querySelector<HTMLElement>("[data-discovery-title]");
  const discoveryKicker = root.querySelector<HTMLElement>("[data-discovery-kicker]");
  const dialog = root.querySelector<HTMLDialogElement>(".direct-chat-dialog");
  const directUser = dialog?.querySelector<HTMLElement>("[data-direct-chat-user]");
  const directMessages = dialog?.querySelector<HTMLElement>("[data-direct-chat-messages]");
  const directForm = dialog?.querySelector<HTMLFormElement>("[data-direct-chat-form]");
  const directError = dialog?.querySelector<HTMLElement>("[data-direct-chat-error]");
  const friendNames = new Set(friends.map((friend) => friend.username));
  let searchTimer = 0;
  let searchSequence = 0;
  let conversationTimer = 0;
  let activeUsername = "";
  let conversationLoading = false;

  const bindPlayerActions = (scope: ParentNode = root) => {
    scope.querySelectorAll<HTMLButtonElement>("[data-add-friend]").forEach((button) => {
      button.addEventListener("click", async () => {
        const username = button.dataset.addFriend || "";
        button.disabled = true;
        try {
          await api.follow(username);
          friendNames.add(username);
          toast(`@${username} fue agregado a tus amigos.`);
          await renderCommunity();
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
          toast(`@${username} fue eliminado de tus amigos.`);
          await renderCommunity();
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

  const renderDiscovery = (players: Array<User & { rating?: number }>, searching: boolean) => {
    if (!discoveryList) return;
    const visible = players.filter((player) => player.id !== currentUser?.id).slice(0, 20);
    discoveryList.innerHTML = visible.length
      ? visible.map((player) => communityPlayerMarkup(player, friendNames.has(player.username), "discover")).join("")
      : `<div class="community-empty"><span>${icon("search")}</span><b>No encontramos jugadores</b><p>Prueba con otro nombre o usuario.</p></div>`;
    if (discoveryTitle) discoveryTitle.textContent = searching ? "Resultados" : "Descubrir jugadores";
    if (discoveryKicker) discoveryKicker.textContent = searching ? "BÚSQUEDA DE JUGADORES" : "CLASIFICACIÓN MUNDIAL";
    bindPlayerActions(discoveryList);
  };

  const renderDirectMessages = (messages: DirectMessage[]) => {
    if (!directMessages) return;
    directMessages.innerHTML = messages.length
      ? messages.map((message) => `<article class="direct-message ${message.own ? "is-own" : ""}"><p>${escapeHtml(message.message)}</p><time>${new Date(message.createdAt).toLocaleTimeString("es-DO", { hour: "2-digit", minute: "2-digit" })}</time></article>`).join("")
      : `<div class="direct-chat-empty"><span>${icon("chat")}</span><p>Inicia la conversación con un saludo.</p></div>`;
    directMessages.scrollTop = directMessages.scrollHeight;
  };

  const refreshConversation = async () => {
    if (!activeUsername || conversationLoading || !dialog?.open) return;
    conversationLoading = true;
    try {
      const response = await api.directMessages(activeUsername);
      if (!dialog.open || response.user.username !== activeUsername) return;
      if (directUser) directUser.innerHTML = `${avatarMarkup(response.user, "avatar avatar--community")}<span><b id="direct-chat-name">${escapeHtml(response.user.name)}</b><small>${flag(response.user.countryCode)} @${escapeHtml(response.user.username)}</small></span>`;
      renderDirectMessages(response.messages);
      root.querySelector(`[data-open-conversation="${CSS.escape(activeUsername)}"] i`)?.remove();
    } catch (error) {
      if (directError) directError.textContent = errorMessage(error);
    } finally {
      conversationLoading = false;
    }
  };

  const closeConversation = () => {
    if (conversationTimer) window.clearInterval(conversationTimer);
    conversationTimer = 0;
    activeUsername = "";
    dialog?.close();
  };

  const openConversation = async (username: string) => {
    if (!dialog || !username) return;
    activeUsername = username;
    if (directUser) directUser.innerHTML = `<span><b id="direct-chat-name">Cargando…</b><small>@${escapeHtml(username)}</small></span>`;
    if (directMessages) directMessages.innerHTML = `<span class="loader loader--small"></span>`;
    if (directError) directError.textContent = "";
    if (!dialog.open) dialog.showModal();
    await refreshConversation();
    if (conversationTimer) window.clearInterval(conversationTimer);
    conversationTimer = window.setInterval(() => void refreshConversation(), 3500);
  };

  bindPlayerActions();
  search?.addEventListener("input", () => {
    if (searchTimer) window.clearTimeout(searchTimer);
    const query = search.value.trim();
    const sequence = ++searchSequence;
    if (query.length < 2) {
      renderDiscovery(initialDiscovery, false);
      return;
    }
    if (discoveryList) discoveryList.innerHTML = `<div class="community-searching"><span class="loader loader--small"></span><p>Buscando jugadores…</p></div>`;
    searchTimer = window.setTimeout(async () => {
      try {
        const response = await api.searchUsers(query);
        if (sequence === searchSequence) renderDiscovery(response.users, true);
      } catch (error) {
        if (sequence === searchSequence && discoveryList) discoveryList.innerHTML = `<div class="community-empty"><b>No pudimos buscar</b><p>${escapeHtml(errorMessage(error))}</p></div>`;
      }
    }, 320);
  });
  dialog?.querySelector("[data-close-direct-chat]")?.addEventListener("click", closeConversation);
  dialog?.addEventListener("cancel", () => {
    if (conversationTimer) window.clearInterval(conversationTimer);
    conversationTimer = 0;
    activeUsername = "";
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
      await api.sendDirectMessage(activeUsername, message);
      input.value = "";
      await refreshConversation();
    } catch (error) {
      if (directError) directError.textContent = errorMessage(error);
    } finally {
      submit?.removeAttribute("disabled");
      input.focus();
    }
  });
  pageCleanup = () => {
    if (searchTimer) window.clearTimeout(searchTimer);
    if (conversationTimer) window.clearInterval(conversationTimer);
    if (dialog?.open) dialog.close();
  };
}

function tournamentDate(value: string | Date) {
  return new Date(value).toLocaleDateString("es-DO", {
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
  return participants.map((participant) => `<button class="tournament-participant-card" type="button" data-tournament-profile="${escapeHtml(participant.username)}">
    ${avatarMarkup(participant, "avatar avatar--tournament")}
    <span><b>${escapeHtml(participant.name)}</b><small>${flag(participant.countryCode)} @${escapeHtml(participant.username)}</small><em class="elo-tier-badge">${escapeHtml(participant.tier ?? eloTier(participant.rating))}</em></span>
    <strong>${participant.rating.toLocaleString("es-DO")}<small>Elo Damas</small></strong>
    <i aria-hidden="true">→</i>
  </button>`).join("");
}

function tournamentPlayerProfileMarkup(
  response: Awaited<ReturnType<typeof api.playerStatistics>>,
) {
  const profile = response.profile;
  const mode = response.modes.find((item) => item.boardSize === 10) ?? response.modes[0];
  const joined = profile.memberSince
    ? new Date(profile.memberSince).toLocaleDateString("es-DO", { month: "short", year: "numeric" })
    : "—";
  return `<section class="tournament-player-profile">
    <button class="tournament-profile-back" type="button" data-back-participants>← Todos los inscritos</button>
    <div class="tournament-profile-hero">
      ${avatarMarkup(profile, "avatar avatar--tournament-profile")}
      <span><small>JUGADOR INSCRITO</small><h3>${escapeHtml(profile.name)}</h3><p>${flag(profile.countryCode)} @${escapeHtml(profile.username)}</p><em class="elo-tier-badge">${escapeHtml(mode?.tier ?? eloTier(mode?.rating ?? 1200))}</em></span>
      ${!profile.isSelf ? `<button class="button ${profile.isFollowing ? "button--quiet" : "button--primary"} button--small" type="button" data-follow-tournament-player="${escapeHtml(profile.username)}" ${profile.isFollowing ? "disabled" : ""}>${profile.isFollowing ? "✓ En tus amigos" : `${icon("userPlus")} Agregar amigo`}</button>` : `<span class="tournament-own-profile">Tu perfil</span>`}
    </div>
    <div class="tournament-profile-rating"><span><small>Elo Damas</small><b>${mode?.rating?.toLocaleString("es-DO") ?? "1,200"}</b></span><span><small>Mejor Elo</small><b>${mode?.peakRating?.toLocaleString("es-DO") ?? mode?.rating?.toLocaleString("es-DO") ?? "1,200"}</b></span><span><small>Ranking mundial</small><b>${mode?.worldPosition ? `#${mode.worldPosition}` : "—"}</b></span><span><small>Ranking nacional</small><b>${mode?.countryPosition ? `#${mode.countryPosition}` : "—"}</b></span></div>
    <div class="tournament-profile-record"><span><b>${response.summary.totalGames}</b><small>Partidas</small></span><span><b>${response.summary.wins}</b><small>Victorias</small></span><span><b>${response.summary.winRate}%</b><small>Rendimiento</small></span><span><b>${profile.followerCount}</b><small>Seguidores</small></span></div>
    <div class="tournament-profile-meta"><span><small>Miembro desde</small><b>${escapeHtml(joined)}</b></span><span><small>Actividad reciente</small><b>${response.summary.gamesLast30Days} partidas en 30 días</b></span><span><small>Promedio</small><b>${response.summary.averageMoves || 0} movimientos</b></span></div>
  </section>`;
}

function qualifierMatchDate(value: string) {
  return new Date(value).toLocaleDateString("es-DO", {
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
  return `<span class="qualifier-bracket-player ${winner ? "is-winner" : ""}">
    ${avatarMarkup(player, "avatar avatar--bracket")}
    <span><b>${escapeHtml(player.name)}</b><small>@${escapeHtml(player.username)} · ${player.rating.toLocaleString("es-DO")}</small></span>
    ${winner ? "<i>✓</i>" : ""}
  </span>`;
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
          ? `<div class="qualifier-viewer-match"><span>${avatarMarkup(viewer.opponent, "avatar avatar--bracket-opponent")}</span><p><small>TU PRÓXIMO RIVAL · ${viewer.scheduledAt ? qualifierMatchDate(viewer.scheduledAt) : "FECHA POR CONFIRMAR"}</small><b>${escapeHtml(viewer.opponent.name)}</b><em>${flag(viewer.opponent.countryCode)} @${escapeHtml(viewer.opponent.username)} · ${viewer.opponent.rating.toLocaleString("es-DO")} Elo Damas</em></p></div>`
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
      ? `<span class="is-filled"><i>${index + 1}</i>${avatarMarkup(player, "avatar avatar--qualifier-slot")}<p><b>${escapeHtml(player.name)}</b><small>@${escapeHtml(player.username)}</small></p><em>CLASIFICADO</em></span>`
      : `<span><i>${index + 1}</i><div class="qualifier-slot-pending">?</div><p><b>Cupo por definir</b><small>Avanza un sobreviviente</small></p></span>`).join("")}</div></section>
    <section class="qualifier-calendar"><header><span><small>CALENDARIO OFICIAL</small><h3>Fechas de ronda</h3></span><p>El cuadro se actualiza automáticamente después de completar cada ronda.</p></header><div>${bracket.calendar.map((entry) => `<span class="${bracket.rounds.some((round) => round.round === entry.round) ? "has-matches" : ""}"><small>R${entry.round}</small><b>${qualifierMatchDate(entry.scheduledAt).replace(/ de /g, " ")}</b></span>`).join("")}</div></section>
    <section class="qualifier-rounds"><header><span><small>ENFRENTAMIENTOS</small><h3>${bracket.tournament.status === "open" ? "Primera ronda provisional" : "Cuadro en vivo"}</h3></span><p>${bracket.tournament.status === "open" ? "Los pares se asignan por orden de inscripción; el último jugador sin pareja espera la siguiente inscripción." : "Los ganadores continúan y dos derrotas eliminan."}</p></header>
      <div class="qualifier-round-columns">${bracket.rounds.length ? bracket.rounds.map((round) => `<article class="qualifier-round-column"><header><span><small>RONDA ${round.round}</small><b>${qualifierMatchDate(round.scheduledAt)}</b></span><em class="is-${round.status}">${round.status === "in_progress" ? "En juego" : round.status === "completed" ? "Completada" : "Programada"}</em></header><div>${round.matches.map((match) => `<article class="qualifier-match ${match.status === "pending_opponent" ? "is-pending" : ""}">${qualifierBracketPlayerMarkup(match.ivory, match)}<i>VS</i>${qualifierBracketPlayerMarkup(match.mahogany, match)}<footer>${match.provisional ? "Cruce reservado por inscripción" : match.status === "active" ? "Partida disponible" : match.status === "completed" ? "Resultado confirmado" : "Partida cerrada"}</footer></article>`).join("")}</div></article>`).join("") : `<div class="qualifier-bracket-empty"><span>${icon("users")}</span><b>Esperando jugadores de ${flag(countryCode)} ${escapeHtml(countryCode)}</b><p>El primer cruce aparecerá cuando se confirme una inscripción.</p></div>`}</div>
    </section>
    <section class="qualifier-participant-status"><header><span><small>ESTADO DEL PAÍS</small><h3>Jugadores en ruta</h3></span></header><div>${bracket.participants.length ? bracket.participants.map((player) => `<span>${avatarMarkup(player, "avatar avatar--bracket-status")}<p><b>${escapeHtml(player.name)}</b><small>@${escapeHtml(player.username)} · ${escapeHtml(player.tier)}</small></p><strong>${player.losses}<small>derrotas</small></strong><em class="is-${player.state}">${stateLabels[player.state]}</em></span>`).join("") : `<p class="qualifier-status-empty">Todavía no hay jugadores inscritos en este país.</p>`}</div></section>
    <p class="qualifier-bracket-note">Los cruces son nacionales y dinámicos. Si una ronda tiene un número impar de jugadores, uno descansa; el sistema rota ese descanso y evita repetir rivales cuando existe otra pareja disponible.</p>`;
}

function tournamentsMarkup(
  qualifier: QualifierTournamentResponse,
  world: WorldChampionshipResponse,
  payment: Awaited<ReturnType<typeof api.donationConfig>>,
  participants: TournamentParticipant[],
) {
  const qualifierTournament = qualifier.tournament;
  const qualifierYear = qualifierTournament?.qualifierYear
    ?? Math.max(2027, new Date(qualifier.registrationStartsAt || Date.now()).getUTCFullYear());
  const worldTournament = world.tournament;
  const worldYear = worldTournament?.championshipYear ?? new Date(world.nextStartsAt).getUTCFullYear();
  const qualifierState = tournamentStatus(qualifierTournament, "Próxima inscripción");
  const worldState = tournamentStatus(worldTournament, "Próxima edición");
  const entryFee = Number(qualifier.entryFee.amount).toFixed(2);
  const canRegister = Boolean(
    qualifierTournament?.status === "open" && !qualifier.viewer?.registered,
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
        <header><span class="tournament-emblem">${icon("users")}</span><div><small>ETAPA 1 · ${qualifierYear}</small><h2>Clasificación al<br>Campeonato Mundial</h2></div><div class="tournament-header-actions"><span class="tournament-status ${qualifierState.className}"><i></i>${qualifierState.label}</span>${canRegister ? `<button class="button button--primary tournament-entry-button tournament-entry-button--top" type="button" data-open-tournament-entry>${icon("tournament")} Inscribirme por $${entryFee}</button>` : ""}</div></header>
        <p class="tournament-description">Compite contra jugadores de tu país. Sobrevive a las rondas y gana uno de los cupos para representar a tu bandera.</p>
        <div class="tournament-facts"><span><small>Modalidad</small><b>10 × 10</b></span><span><small>Reloj</small><b>30 min</b></span><span><small>Inscripción</small><b>$${entryFee}</b></span><span><small>Participantes</small><b>${qualifierTournament?.participantCount ?? 0}</b></span></div>
        <div class="tournament-timeline">
          <span class="is-active"><i></i><p><small>INSCRIPCIÓN HASTA</small><b>${tournamentDate(registrationEnd)}</b></p></span>
          <span><i></i><p><small>COMPETENCIA</small><b>${tournamentDate(qualifierStarts)} – ${tournamentDate(qualifierEnds)}</b></p></span>
        </div>
        <section class="tournament-registered-preview">
          <div><small>PERFILES DEL TORNEO</small><h3>Jugadores inscritos</h3></div>
          <div class="tournament-avatar-stack">${participants.slice(0, 5).map((participant) => avatarMarkup(participant, "avatar avatar--tournament-stack")).join("")}${participants.length > 5 ? `<span>+${participants.length - 5}</span>` : ""}</div>
          <strong>${participants.length}<small>${participants.length === 1 ? "jugador" : "jugadores"}</small></strong>
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
        <div class="world-prizes"><small>DISTRIBUCIÓN DEL FONDO DE PREMIOS</small><div><span class="is-gold"><i>1</i><b>20%</b><small>Campeón</small></span><span class="is-silver"><i>2</i><b>10%</b><small>Segundo</small></span><span class="is-bronze"><i>3</i><b>5%</b><small>Tercero</small></span></div>${worldTournament?.prizePool ? `<p>Fondo actual: <b>${worldTournament.prizePool.currency} ${worldTournament.prizePool.amount.toLocaleString("es-DO")}</b></p>` : ""}</div>
        <ul class="tournament-rules"><li><span>🌎</span><p><b>Representación internacional</b><small>Los tres clasificados oficiales de cada país.</small></p></li><li><span>↻</span><p><b>Todos contra todos</b><small>Cada participante enfrenta a cada rival una vez.</small></p></li><li><span>♛</span><p><b>Un campeón mundial</b><small>La clasificación final corona al mejor de la temporada.</small></p></li></ul>
        ${worldTournament?.isParticipant ? `<div class="tournament-viewer is-qualified"><span>✓</span><p><b>Estás en el Campeonato Mundial</b><small>Tu clasificación fue registrada automáticamente.</small></p></div>` : `<div class="tournament-callout tournament-callout--world">El acceso es automático: clasifica primero en la etapa de tu país.</div>`}
      </article>
    </div>
    <dialog class="tournament-entry-dialog" aria-labelledby="tournament-entry-title">
      <button class="dialog-close" type="button" data-close-tournament-entry aria-label="Cerrar">×</button>
      <span class="tournament-entry-seal">${icon("tournament")}</span>
      <span class="section-kicker">INSCRIPCIÓN OFICIAL · ${qualifierYear}</span>
      <h2 id="tournament-entry-title">Representa a tu país</h2>
      <p>Tu inscripción corresponde a la Clasificación al Campeonato Mundial y se confirma al completar el pago.</p>
      <div class="tournament-entry-summary"><span><small>Modalidad</small><b>10 × 10</b></span><span><small>País</small><b>${flag(currentUser?.countryCode || "")} ${escapeHtml(currentUser?.countryCode || "")}</b></span><span><small>Total</small><b>${qualifier.entryFee.currency} $${entryFee}</b></span></div>
      <p class="tournament-entry-error" data-tournament-entry-error aria-live="polite"></p>
      <div class="tournament-paypal" data-tournament-paypal>${payment.enabled ? `<span class="loader loader--small"></span><small>Preparando pago seguro…</small>` : `<div class="donation-sdk-error"><b>PayPal no está disponible ahora mismo.</b><small>Inténtalo nuevamente más tarde.</small></div>`}</div>
      <small class="tournament-entry-note">Al continuar confirmas que deseas participar bajo las reglas oficiales del torneo. El pago no mejora tu Elo ni concede ventajas.</small>
    </dialog>
    <dialog class="tournament-participants-dialog" aria-labelledby="tournament-participants-title">
      <header><div><span class="section-kicker">CLASIFICATORIA ${qualifierYear}</span><h2 id="tournament-participants-title" data-participants-title>Jugadores inscritos</h2><p data-participants-subtitle>${participants.length} ${participants.length === 1 ? "perfil confirmado" : "perfiles confirmados"}</p></div><button type="button" data-close-tournament-participants aria-label="Cerrar">×</button></header>
      <label class="tournament-participant-search" data-participant-search-wrap><span>${icon("search")}</span><input type="search" autocomplete="off" placeholder="Buscar en los inscritos…" data-participant-search /></label>
      <p class="tournament-participants-error" data-participants-error aria-live="polite"></p>
      <div class="tournament-participants-grid" data-participants-grid>${tournamentParticipantCards(participants)}</div>
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
    const [qualifier, world, payment] = await Promise.all([
      api.qualifierTournament(),
      api.worldChampionship(),
      api.donationConfig(),
    ]);
    const participants = qualifier.tournament
      ? (await api.tournamentParticipants(qualifier.tournament.id)).participants
      : [];
    root.innerHTML = appLayout(tournamentsMarkup(qualifier, world, payment, participants), "tournaments");
    bindNavigation();
    bindTournaments(qualifier, payment, participants);
  } catch (error) {
    root.innerHTML = appLayout(errorState(errorMessage(error)), "tournaments");
    bindNavigation();
    bindRetry(() => renderTournaments());
  }
}

function bindTournaments(
  qualifier: QualifierTournamentResponse,
  payment: Awaited<ReturnType<typeof api.donationConfig>>,
  participants: TournamentParticipant[],
) {
  const tournament = qualifier.tournament;
  const dialog = root.querySelector<HTMLDialogElement>(".tournament-entry-dialog");
  const container = dialog?.querySelector<HTMLElement>("[data-tournament-paypal]");
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

  const closeDialog = () => dialog?.close();
  dialog?.querySelector("[data-close-tournament-entry]")?.addEventListener("click", closeDialog);
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog();
  });
  root.querySelector("[data-open-tournament-entry]")?.addEventListener("click", async () => {
    if (!dialog || !container || !error || !tournament) return;
    dialog.showModal();
    if (!payment.enabled || !payment.clientId || paymentButtons || initializing) return;
    initializing = true;
    error.textContent = "";
    try {
      const paypal = await loadPayPalSdk(payment.clientId, payment.currency);
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
  const showParticipantList = (visible = participants) => {
    if (!participantsGrid) return;
    participantsGrid.innerHTML = tournamentParticipantCards(visible);
    if (participantsTitle) participantsTitle.textContent = "Jugadores inscritos";
    if (participantsSubtitle) participantsSubtitle.textContent = `${participants.length} ${participants.length === 1 ? "perfil confirmado" : "perfiles confirmados"}`;
    if (participantSearchWrap) participantSearchWrap.hidden = false;
    if (participantsError) participantsError.textContent = "";
    participantsGrid.querySelectorAll<HTMLButtonElement>("[data-tournament-profile]").forEach((button) => {
      button.addEventListener("click", () => void showPlayerProfile(button.dataset.tournamentProfile || ""));
    });
  };
  const showPlayerProfile = async (username: string) => {
    if (!participantsGrid || !username) return;
    participantsGrid.innerHTML = `<div class="tournament-profile-loading"><span class="loader"></span><p>Cargando perfil…</p></div>`;
    if (participantsTitle) participantsTitle.textContent = "Perfil del jugador";
    if (participantsSubtitle) participantsSubtitle.textContent = `@${username}`;
    if (participantSearchWrap) participantSearchWrap.hidden = true;
    if (participantsError) participantsError.textContent = "";
    try {
      const response = await api.playerStatistics(username);
      participantsGrid.innerHTML = tournamentPlayerProfileMarkup(response);
      participantsGrid.querySelector("[data-back-participants]")?.addEventListener("click", () => showParticipantList());
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
      participantsGrid.innerHTML = `<div class="tournament-participants-empty"><b>No pudimos cargar el perfil</b><p>${escapeHtml(errorMessage(error))}</p><button type="button" data-back-participants>Volver a los inscritos</button></div>`;
      participantsGrid.querySelector("[data-back-participants]")?.addEventListener("click", () => showParticipantList());
    }
  };
  root.querySelector("[data-open-tournament-participants]")?.addEventListener("click", () => {
    if (!participantsDialog) return;
    if (participantSearch) participantSearch.value = "";
    showParticipantList();
    participantsDialog.showModal();
  });
  participantsDialog?.querySelector("[data-close-tournament-participants]")?.addEventListener("click", () => participantsDialog.close());
  participantsDialog?.addEventListener("click", (event) => {
    if (event.target === participantsDialog) participantsDialog.close();
  });
  participantSearch?.addEventListener("input", () => {
    const query = participantSearch.value.trim().toLocaleLowerCase("es");
    const visible = participants.filter((participant) =>
      participant.name.toLocaleLowerCase("es").includes(query)
      || participant.username.toLocaleLowerCase("es").includes(query),
    );
    showParticipantList(visible);
    if (participantSearch) participantSearch.value = query;
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
  if (!token || !modal || !input) return;
  const url = invitationUrl(token);
  input.value = url;
  if (time) time.textContent = `${invitation.timeControlMinutes} minutos`;
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
  modal.querySelector("[data-copy-invite-text]")?.addEventListener("click", () => void showCopied());
  modal.querySelector("[data-share-invite]")?.addEventListener("click", async () => {
    if (!navigator.share) return showCopied();
    try {
      await navigator.share({
        title: `@${currentUser?.username ?? "jugador"} te desafía en King Damas`,
        text: `¿Aceptas una partida de damas 10×10 a ${invitation.timeControlMinutes} minutos?`,
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
    handleMatchmaking(await api.joinMatchmaking(selectedTime));
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
    handleMatchmaking(await api.matchmakingStatus(selectedTime));
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
    root.innerHTML = appLayout(`
      <section class="page-heading"><div><span class="eyebrow"><i></i>Elo Damas oficial</span><h1>Clasificación</h1><p>Los jugadores que están marcando el ritmo en la modalidad 10×10.</p></div><span class="mode-pill mode-pill--large">10 × 10</span></section>
      ${eloTierScaleMarkup()}
      <section class="panel leaderboard-panel">
        <div class="leaderboard-toolbar">
          <div class="scope-toggle"><button class="${scope === "DO" ? "is-active" : ""}" data-scope="DO">${flag("DO")} Nacional</button><button class="${scope === "WORLD" ? "is-active" : ""}" data-scope="WORLD">🌐 Mundial</button></div>
          <span>${response.totalPlayers} jugadores clasificados</span>
        </div>
        ${leaderboardTable(response.players, false)}
      </section>`, "ranking");
    bindNavigation();
    root.querySelectorAll<HTMLButtonElement>("[data-scope]").forEach((button) => {
      button.addEventListener("click", () => void loadLeaderboard(button.dataset.scope as "DO" | "WORLD"));
    });
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
      <span class="rank-player">${avatarMarkup(player, "avatar avatar--table")}<span><b>${escapeHtml(player.name)}</b><small>${flag(player.countryCode)} @${escapeHtml(player.username)}</small></span></span>
      <span>${player.gamesPlayed}</span><span>${player.wins}-${player.losses}-${player.draws}</span><strong>${player.rating.toLocaleString("es-DO")}<small>${escapeHtml(player.tier ?? eloTier(player.rating))}</small></strong>
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
          <span class="invite-seal invite-seal--large invite-brand-mark"><img src="/brand/icon-192.png?v=green-1" alt="" /></span>
          <span class="section-kicker">INVITACIÓN PRIVADA</span>
          <h1>${ownInvitation ? "Este es tu desafío" : `@${escapeHtml(invitation.sender.username)} te espera`}</h1>
          <p>${ownInvitation ? "Comparte el enlace original y espera a que tu amigo lo acepte." : "¿Puedes arrebatarle la corona? Acepta el desafío y demuestra tu nivel en el tablero."}</p>
          <div class="challenger-card">
            ${avatarMarkup(invitation.sender, "avatar avatar--challenger")}
            <span><small>QUIEN TE DESAFÍA</small><b>${escapeHtml(invitation.sender.name)}</b><em>@${escapeHtml(invitation.sender.username)}</em></span>
            <strong>${invitation.sender.rating}<small>Elo Damas</small></strong>
          </div>
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
        : "IV · El Trono";
  const state = defeated ? "is-defeated" : unlocked ? "is-unlocked" : "is-locked";
  return `<article class="legend-road-card ${state}" style="--legend-accent:${legend.accent}">
    <span class="legend-road-level"><i>${legend.level}</i></span>
    ${legendAvatarMarkup(legend, "legend-road-avatar", true)}
    <div class="legend-road-copy"><small>ACTO ${chapter} · NIVEL ${legend.level}</small><h2>${escapeHtml(legend.name)}</h2><b>${escapeHtml(legend.epithet)} · ${escapeHtml(legend.difficulty)}</b><p>${escapeHtml(legend.description)}</p><div class="legend-strength" aria-label="Dificultad ${legend.level} de ${LEGENDS.length}">${LEGENDS.map((_, index) => `<i class="${index < legend.level ? "is-filled" : ""}"></i>`).join("")}</div></div>
    <div class="legend-road-action"><span>${defeated ? "✓ Superado" : unlocked ? `${legend.rating.toLocaleString("es-DO")} fuerza` : "Bloqueado"}</span>${unlocked ? `<button class="button ${legend.level === LEGENDS.length ? "button--legend" : "button--outline"} button--small" type="button" data-play-legend="${legend.key}">${defeated ? "Jugar de nuevo" : "Desafiar"}</button>` : `<i aria-label="Nivel bloqueado">🔒</i>`}</div>
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
        <div><button class="text-button" type="button" data-route="/inicio">← Volver al inicio</button><span class="eyebrow"><i></i>20 RIVALES · 4 ACTOS</span><h1>Camino de Leyendas</h1><p>Supera veinte personajes mitológicos, desde un espíritu ideal para aprender hasta Hades, casi imposible de vencer. Cada victoria abre el siguiente duelo.</p></div>
        <div class="legend-road-progress"><span>${icon("crown")}</span><p><small>CAMINO COMPLETADO</small><b>${defeatedCount} <i>/ ${LEGENDS.length}</i></b><em><i style="width:${(defeatedCount / LEGENDS.length) * 100}%"></i></em></p></div>
      </header>
      <section class="legend-road-toolbar panel"><div><span class="section-kicker">RELOJ POR JUGADOR</span><div>${TIME_CONTROLS.map((minutes) => `<button class="${minutes === timeControl ? "is-active" : ""}" type="button" data-legend-road-time="${minutes}">${minutes} min</button>`).join("")}</div></div><p><b>Práctica sin riesgo</b><small>Estas partidas no modifican tu Elo Damas.</small></p>${nextLegend ? `<button class="button button--legend" type="button" data-play-legend="${nextLegend.key}">${icon("play")} Continuar con ${escapeHtml(nextLegend.name)}</button>` : ""}</section>
      <section class="legend-roadmap" aria-label="Progresión de leyendas">
        ${LEGENDS.map((legend, index) => legendRoadCardMarkup(legend, index < unlockedCount, defeated.has(legend.key))).join("")}
      </section>
      <aside class="legend-road-help"><span>i</span><p><b>Cuatro actos, veinte leyendas</b><small>Fundamentos, Táctica, Maestría y El Trono. Cada victoria queda guardada y desbloquea el siguiente personaje en todos tus dispositivos.</small></p></aside>
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
            <div class="player-identity"><span class="avatar-slot" data-current-user-avatar data-avatar-class="avatar avatar--player">${avatarMarkup(currentUser, "avatar avatar--player")}</span><span><span class="player-name-line"><i title="${escapeHtml(currentUser.countryCode)}">${flag(currentUser.countryCode)}</i><b>${escapeHtml(currentUser.name)} (Tú)</b></span><small>@${escapeHtml(currentUser.username)} · práctica</small></span></div>
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
    pieceColors: { ivory: "blanca", mahogany: "dorado" },
    onMove: (move) => playMove(move, humanSide),
  });
  bindGameSettings({
    onResign: () => {
      if (window.confirm(`¿Confirmas que deseas rendirte ante ${legend.name}?`)) finish(machineSide, "resignation");
    },
    onNewGame: () => {
      if (status !== "active" || window.confirm("¿Quieres abandonar esta partida y comenzar otra?")) void renderLegendGame(timeControl, legend.key);
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
      <div class="live-player ${game.currentPlayer === "ivory" ? "is-turn" : ""}">${avatarMarkup(ivory, "avatar avatar--live")}<span><small>${flag(ivory.countryCode)} @${escapeHtml(ivory.username)}</small><b>${escapeHtml(ivory.name)}</b><em>${ivory.rating.rating.toLocaleString("es-DO")} Elo Damas</em></span></div>
      <span class="live-versus">VS</span>
      <div class="live-player ${game.currentPlayer === "mahogany" ? "is-turn" : ""}">${avatarMarkup(mahogany, "avatar avatar--live")}<span><small>${flag(mahogany.countryCode)} @${escapeHtml(mahogany.username)}</small><b>${escapeHtml(mahogany.name)}</b><em>${mahogany.rating.rating.toLocaleString("es-DO")} Elo Damas</em></span></div>
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
      <section class="live-games-grid" data-live-games>${liveGamesListMarkup(response.games)}</section>
    `, "watch");
    bindLiveGameCards();

    const refresh = async () => {
      try {
        const next = await api.spectatorGames();
        if (route() !== "/en-vivo") return;
        const list = root.querySelector<HTMLElement>("[data-live-games]");
        const total = root.querySelector<HTMLElement>("[data-live-total]");
        if (list) list.innerHTML = liveGamesListMarkup(next.games);
        if (total) total.textContent = String(next.total);
        bindLiveGameCards();
      } catch {
        // La siguiente actualización vuelve a intentarlo sin vaciar la lista.
      }
    };
    root.querySelector("[data-refresh-live]")?.addEventListener("click", () => void refresh());
    const refreshTimer = window.setInterval(() => void refresh(), 10_000);
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
    <div class="player-identity">${avatarMarkup(player, "avatar avatar--player")}<span><span class="player-name-line"><i title="${escapeHtml(player.countryCode)}">${flag(player.countryCode)}</i><b>${escapeHtml(player.name)}</b></span><small>@${escapeHtml(player.username)}</small></span></div>
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
    container.innerHTML = `<div class="board-result-card"><span class="result-icon">${winner ? "♛" : "½"}</span><span class="section-kicker">TRANSMISIÓN FINALIZADA</span><h2>${winner ? `Victoria de ${escapeHtml(winner.name)}` : "Tablas"}</h2><p>${endReasonLabel(game.endReason)}</p><div class="result-summary"><span><small>Jugadas</small><b>${game.moveCount}</b></span><span><small>Ritmo</small><b>${game.timeControlMinutes} min</b></span><span><small>Espectadores</small><b>${spectatorCount}</b></span></div><div class="result-actions"><button class="button button--primary" type="button" data-result-live>${icon("eye")} Ver otras partidas</button><button class="button button--quiet" type="button" data-result-home>Volver al inicio</button></div></div>`;
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
  let completedAt = game.status === "active" ? 0 : Date.now();
  let sentRematchId: string | null = null;
  let incomingRematch: DirectInvitation | null = null;
  let rematchState: "idle" | "sending" | "waiting" | "declined" | "error" = "idle";
  let rematchFeedback = "";

  root.innerHTML = appLayout(`
    <section class="game-page">
      <header class="game-titlebar"><button class="text-button" data-route="/inicio">← Volver al inicio</button><span class="game-title-meta"><span class="mode-pill">10×10 · ${game.timeControlMinutes} min</span><span class="game-viewer-count" aria-label="Espectadores conectados">${icon("eye")} <b data-player-spectator-count>0</b></span></span><strong class="game-state-label"></strong></header>
      <div class="game-layout">
        <section class="board-column">
          ${playerBar(opponent, opponentSide, "opponent", countPieces(game.board)[opponentSide].total)}
          <div class="board-shell"><div id="live-board"></div><div class="board-result-overlay" aria-hidden="true"></div></div>
          ${playerBar(own, ownSide, "own", countPieces(game.board)[ownSide].total)}
          <div class="draw-offer"></div>
        </section>
        <aside class="game-sidebar">
          <div class="game-tabs"><button class="is-active">Jugada</button><button data-chat-tab>Chat <i class="chat-unread"></i></button></div>
          <div class="moves-panel"><div class="moves-list"></div></div>
          <div class="chat-panel">
            <div class="chat-messages"><div class="chat-placeholder">Aún no hay mensajes.<br>Saluda a tu rival.</div></div>
            <form class="chat-form"><input maxlength="160" name="message" autocomplete="off" placeholder="Escribe un mensaje…" aria-label="Mensaje" /><button type="submit" aria-label="Enviar">↑</button></form>
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
    if (wasActive && game.status !== "active") completedAt = Date.now();
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
      <p>${endReasonLabel(state.endReason)} Rival: <strong>@${escapeHtml(opponent.username)}</strong></p>
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
  const finishByPlayer = async (message?: string) => {
    if (game.status !== "active") return true;
    if (!window.confirm(message || "¿Seguro que quieres abandonar esta partida? Si sales ahora, perderás la partida y el resultado quedará registrado.")) return false;
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
  const leaveGuard = () => finishByPlayer(
    "¿Seguro que quieres abandonar esta partida? Si cambias de página ahora, perderás la partida y el resultado quedará registrado.",
  );
  pageLeaveGuard = leaveGuard;
  const handleBeforeUnload = (event: BeforeUnloadEvent) => {
    if (game.status !== "active" || exitRequestInFlight) return;
    event.preventDefault();
    event.returnValue = "Si sales ahora, perderás la partida.";
  };
  const handlePageHide = () => {
    if (game.status !== "active" || exitRequestInFlight) return;
    exitRequestInFlight = true;
    void api.resignOnUnload(game.id);
  };
  window.addEventListener("beforeunload", handleBeforeUnload);
  window.addEventListener("pagehide", handlePageHide);
  const openChat = () => {
    root.querySelector(".game-sidebar")?.classList.toggle("is-open");
    root.querySelector<HTMLInputElement>(".chat-form input")?.focus();
  };
  bindGameSettings({
    onChat: openChat,
    onDraw: offerDraw,
    onResign: async () => { await finishByPlayer(); },
    onNewGame: async () => {
      if (!(await finishByPlayer("¿Seguro que quieres abandonar esta partida para comenzar otra? Si continúas, perderás la partida actual."))) return;
      navigate("/jugar");
    },
  });
  root.querySelector("[data-chat-tab]")?.addEventListener("click", () => root.querySelector(".game-sidebar")?.classList.add("show-chat"));

  const renderMessages = () => {
    const container = root.querySelector<HTMLElement>(".chat-messages");
    if (!container) return;
    if (!messages.length) {
      container.innerHTML = `<div class="chat-placeholder">Aún no hay mensajes.<br>Saluda a tu rival.</div>`;
      return;
    }
    container.innerHTML = messages.map((message) => `<div class="chat-message ${message.senderId === currentUser?.id || message.own ? "is-mine" : ""}"><small>${escapeHtml(message.username)}</small><p>${escapeHtml(message.message)}</p><time>${new Date(message.sentAt).toLocaleTimeString("es-DO", { hour: "2-digit", minute: "2-digit" })}</time></div>`).join("");
    container.scrollTop = container.scrollHeight;
  };

  root.querySelector<HTMLFormElement>(".chat-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem("message") as HTMLInputElement;
    const value = input.value.trim();
    if (!value) return;
    input.value = "";
    try {
      const response = await api.sendMessage(game.id, value);
      if (!messages.some((item) => item.id === response.message.id)) messages.push(response.message);
      renderMessages();
    } catch (error) { toast(errorMessage(error), "error"); }
  });

  void api.messages(game.id).then((response) => { messages = response.messages; renderMessages(); }).catch(() => {});
  const socketGameUpdate = (next: Game) => { if (String(next.id) === game.id) update({ ...next, playerColor: ownSide }); };
  const socketMessage = (message: ChatMessage) => {
    if (String(message.gameId) !== game.id || messages.some((item) => item.id === message.id)) return;
    messages.push(message);
    renderMessages();
  };
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
    window.removeEventListener("pagehide", handlePageHide);
    board?.destroy();
    window.clearInterval(clockTimer);
    window.clearInterval(syncTimer);
    window.clearInterval(rematchTimer);
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

function gameQuickActions(chatAvailable = true) {
  const sounds = soundPreferences();
  const backgroundVolume = Math.round(sounds.backgroundVolume * 100);
  return `<div class="player-quick-actions">
    <button class="quick-action" type="button" data-quick-chat aria-label="Abrir chat" ${chatAvailable ? "" : "disabled"}>${icon("chat")}</button>
    <button class="quick-action" type="button" data-settings-toggle aria-label="Abrir configuración" aria-expanded="false">${icon("settings")}</button>
    <div class="game-settings-menu" data-settings-menu aria-hidden="true">
      <div class="settings-menu-title"><span>${icon("settings")}</span><b>Configuración</b><button type="button" data-settings-close aria-label="Cerrar configuración">×</button></div>
      <button type="button" data-settings-draw ${chatAvailable ? "" : "disabled"}><span>½</span><b>Tablas</b></button>
      <button type="button" data-settings-resign class="is-danger"><span>⚑</span><b>Rendirse</b></button>
      <div class="settings-toggle-row"><span>${icon("volume")}<b>Movimientos y capturas</b></span><button type="button" role="switch" aria-label="Sonidos de movimientos y capturas" aria-checked="${sounds.moves}" class="mini-switch ${sounds.moves ? "is-on" : ""}" data-move-sound><i></i></button></div>
      <div class="settings-toggle-row"><span><i class="settings-symbol">♫</i><b>Música de fondo</b></span><button type="button" role="switch" aria-label="Música de fondo" aria-checked="${sounds.background}" class="mini-switch ${sounds.background ? "is-on" : ""}" data-background-sound><i></i></button></div>
      <label class="settings-volume-row"><span><i>♪</i><b>Volumen</b></span><span class="volume-slider"><input type="range" min="0" max="100" step="5" value="${backgroundVolume}" aria-label="Volumen de la música de fondo" data-background-volume style="--volume-progress:${backgroundVolume}%" /><output data-background-volume-output>${backgroundVolume}%</output></span></label>
      <details class="audio-credits">
        <summary><span>©</span><b>Créditos de audio</b><i aria-hidden="true">›</i></summary>
        <div><strong>“${escapeHtml(AUDIO_CREDITS.title)}”</strong><span>Música de fondo por <a href="${escapeHtml(AUDIO_CREDITS.creatorUrl)}" target="_blank" rel="noreferrer">${escapeHtml(AUDIO_CREDITS.creator)}</a></span><small>Licencia <a href="${escapeHtml(AUDIO_CREDITS.licenseUrl)}" target="_blank" rel="noreferrer">${escapeHtml(AUDIO_CREDITS.license)}</a></small><em><span>Movimiento · “${escapeHtml(AUDIO_CREDITS.effects.movement.title)}” por <a href="${escapeHtml(AUDIO_CREDITS.effects.movement.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(AUDIO_CREDITS.effects.movement.creator)}</a> · ${AUDIO_CREDITS.effects.movement.licenses.map((license) => `<a href="${escapeHtml(license.url)}" target="_blank" rel="noreferrer">${escapeHtml(license.label)}</a>`).join(" / ")}</span><span>Captura · “${escapeHtml(AUDIO_CREDITS.effects.capture.title)}” por <a href="${escapeHtml(AUDIO_CREDITS.effects.capture.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(AUDIO_CREDITS.effects.capture.creator)}</a> · <a href="${escapeHtml(AUDIO_CREDITS.effects.capture.licenseUrl)}" target="_blank" rel="noreferrer">${escapeHtml(AUDIO_CREDITS.effects.capture.license)}</a></span></em></div>
      </details>
      <button type="button" data-settings-new><span>${icon("refresh")}</span><b>Nueva partida</b></button>
    </div>
  </div>`;
}

function bindGameSettings(actions: {
  onChat?: () => void;
  onDraw?: () => void | Promise<void>;
  onResign: () => void | Promise<void>;
  onNewGame: () => void | Promise<void>;
}) {
  const menu = root.querySelector<HTMLElement>("[data-settings-menu]");
  const toggle = root.querySelector<HTMLButtonElement>("[data-settings-toggle]");
  const sidebar = root.querySelector<HTMLElement>(".game-sidebar");
  if (menu && sidebar) sidebar.append(menu);
  const closeMenu = () => {
    menu?.classList.remove("is-open");
    menu?.setAttribute("aria-hidden", "true");
    toggle?.setAttribute("aria-expanded", "false");
    sidebar?.classList.remove("is-settings-visible");
  };
  toggle?.addEventListener("click", () => {
    const open = !menu?.classList.contains("is-open");
    menu?.classList.toggle("is-open", open);
    menu?.setAttribute("aria-hidden", String(!open));
    toggle.setAttribute("aria-expanded", String(open));
    sidebar?.classList.toggle("is-settings-visible", open);
  });
  root.querySelector("[data-settings-close]")?.addEventListener("click", closeMenu);
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

function playerBar(player: Game["players"][Side], side: Side, placement: string, pieces: number) {
  return `<div class="player-bar player-bar--${placement}" data-player-bar="${side}">
    <div class="player-identity">${placement === "own" ? `<span class="avatar-slot" data-current-user-avatar data-avatar-class="avatar avatar--player">${avatarMarkup(player, "avatar avatar--player")}</span>` : avatarMarkup(player, "avatar avatar--player")}<span><span class="player-name-line"><i title="${escapeHtml(player.countryCode)}">${flag(player.countryCode)}</i><b>${escapeHtml(player.name)} ${placement === "own" ? "(Tú)" : ""}</b></span><small>@${escapeHtml(player.username)}</small></span></div>
    ${playerLiveData(side, player.rating.rating, pieces)}
    <div class="turn-indicator"><i></i><span>Jugando</span></div>
    ${placement === "own" ? gameQuickActions(true) : ""}
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
  socket = io(SOCKET_URL, { withCredentials: true, transports: ["websocket", "polling"] });
  socket.on("matchmaking:matched", (game: Game) => {
    if (matchmakingTimer) void stopMatchmaking(false);
    navigate(`/partida/${game.id}`);
  });
  socket.on("connect_error", (error) => {
    console.warn("Tiempo real no disponible; se usará sincronización HTTP.", error.message);
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
  const sharedInvitation = new URLSearchParams(window.location.search).get("invitacion");
  if (sharedInvitation) return renderSharedInvitation(sharedInvitation);
  if (!currentUser) {
    renderLanding();
    return;
  }
  if (path === "/clasificacion") return renderLeaderboard();
  if (path === "/comunidad") return renderCommunity();
  if (path === "/torneos") return renderTournaments();
  if (path === "/donar") return renderDonation();
  if (path === "/creditos") return renderCredits();
  if (path === "/informacion") return renderInformationHub();
  if (isLegalPath(path)) return renderLegalPage(path);
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

async function handleHashChange() {
  if (bypassNextHashGuard) {
    bypassNextHashGuard = false;
    await renderRoute();
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
}

export async function startApp(user: User | null) {
  currentUser = user;
  if (!routeListenerBound) {
    window.addEventListener("hashchange", () => void handleHashChange());
    routeListenerBound = true;
  }
  if (currentUser) {
    setSessionHint(true);
    await connectRealtime();
  }
  await renderRoute();
}
