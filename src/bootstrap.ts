import "./landing.css";
import { api, ApiError } from "./api";
import { installInterfaceSounds } from "./game/sound";
import { renderPublicLanding } from "./landing";
import type { User } from "./types";
import { initializeI18n, useUserLanguage } from "./i18n";
import { isPublicContentPath, normalizePublicPath } from "./publicRoutes";

const root = document.querySelector<HTMLDivElement>("#app")!;
const SESSION_HINT_KEY = "kingdamas_session_hint";
let launchPromise: Promise<void> | null = null;
let appModulePromise: Promise<typeof import("./main")> | null = null;

function loadAppModule() {
  return (appModulePromise ??= import("./main"));
}

function hasSessionHint() {
  try {
    return localStorage.getItem(SESSION_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

function setSessionHint(active: boolean) {
  try {
    if (active) localStorage.setItem(SESSION_HINT_KEY, "1");
    else localStorage.removeItem(SESSION_HINT_KEY);
  } catch {
    // La cookie HTTP sigue siendo la fuente de verdad de la sesión.
  }
}

function launchApp(user: User | null) {
  if (launchPromise) return launchPromise;
  if (user?.language) useUserLanguage(user.language);
  launchPromise = loadAppModule().then(({ startApp }) => startApp(user));
  return launchPromise;
}

async function bootstrap() {
  const sharedInvitation = new URLSearchParams(window.location.search).has("invitacion");
  const passwordReset = window.location.pathname.replace(/\/+$/, "") === "/restablecer";
  const publicContent = isPublicContentPath(normalizePublicPath(window.location.pathname));
  const optimisticLanding = !hasSessionHint() && !sharedInvitation && !passwordReset && !publicContent;
  if (optimisticLanding) renderPublicLanding(launchApp);
  else {
    root.innerHTML = `<div class="loading-state"><span class="loader"></span><p>Preparando la mesa…</p></div>`;
    // La validación de sesión y la descarga de la interfaz pueden avanzar juntas.
    void loadAppModule().catch(() => {});
  }

  try {
    const user = (await api.me()).user;
    setSessionHint(true);
    await launchApp(user);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) setSessionHint(false);
    else console.warn("No se pudo recuperar la sesión.", error);
    if (sharedInvitation || passwordReset || publicContent) await launchApp(null);
    else if (!optimisticLanding) renderPublicLanding(launchApp);
  }
}

initializeI18n();
installInterfaceSounds();
void bootstrap();
