import "./landing.css";
import { api, ApiError } from "./api";
import { installInterfaceSounds } from "./game/sound";
import { renderPublicLanding } from "./landing";
import type { User } from "./types";

const root = document.querySelector<HTMLDivElement>("#app")!;
const SESSION_HINT_KEY = "kingdamas_session_hint";
let launchPromise: Promise<void> | null = null;

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
  launchPromise = import("./main").then(({ startApp }) => startApp(user));
  return launchPromise;
}

async function bootstrap() {
  const sharedInvitation = new URLSearchParams(window.location.search).has("invitacion");
  const optimisticLanding = !hasSessionHint() && !sharedInvitation;
  if (optimisticLanding) renderPublicLanding(launchApp);
  else root.innerHTML = `<div class="loading-state"><span class="loader"></span><p>Preparando la mesa…</p></div>`;

  try {
    const user = (await api.me()).user;
    setSessionHint(true);
    await launchApp(user);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) setSessionHint(false);
    else console.warn("No se pudo recuperar la sesión.", error);
    if (sharedInvitation) await launchApp(null);
    else if (!optimisticLanding) renderPublicLanding(launchApp);
  }
}

installInterfaceSounds();
void bootstrap();
