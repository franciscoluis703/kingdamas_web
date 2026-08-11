import { api, ApiError } from "./api";
import type { User } from "./types";
import { icon } from "./ui";
import { languageSelectorMarkup, localeCode } from "./i18n";
import { decorativeBoardMarkup } from "./game/decorativeBoard";

const root = document.querySelector<HTMLDivElement>("#app")!;

function brandMarkMarkup() {
  return `<span class="brand-mark"><img src="/favicon-64.png?v=piece-1" width="64" height="64" alt="" /></span>`;
}

function logoMarkup() {
  return `${brandMarkMarkup()}<span class="brand-name">King <b>Damas</b></span>`;
}

function publicHeader() {
  return `
    <header class="public-header container">
      <button class="brand brand--button" type="button" data-public-home aria-label="Ir al inicio">${logoMarkup()}</button>
      <nav class="public-nav" aria-label="Navegación principal">
        <a href="#como-jugar">Cómo jugar</a>
        ${languageSelectorMarkup("language-selector--public")}
        <button class="button button--quiet" type="button" data-open-auth="login">Entrar</button>
        <button class="button button--primary button--small" type="button" data-open-auth="register">Crear cuenta</button>
      </nav>
    </header>`;
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

function errorMessage(error: unknown) {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "Algo salió mal. Inténtalo de nuevo.";
}

function bindAuthDialog(onAuthenticated: (user: User) => Promise<void>) {
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
  root.querySelector("[data-public-home]")?.addEventListener("click", () => {
    location.hash = "/inicio";
    window.scrollTo({ top: 0, behavior: "smooth" });
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
        dialog.close();
        await onAuthenticated(response.user);
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

export function renderPublicLanding(onAuthenticated: (user: User) => Promise<void>) {
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
      </main>
      <footer class="public-footer container"><span>© ${new Date().getFullYear()} King Damas</span><span>Hecho para quienes piensan dos jugadas adelante.</span></footer>
      ${authDialogMarkup()}
    </div>`;
  bindAuthDialog(onAuthenticated);
}
