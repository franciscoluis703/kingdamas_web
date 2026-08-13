const ADSENSE_CLIENT = "ca-pub-3889117121292163";
const ADSENSE_SLOT = "2125052107";
const ADSENSE_SCRIPT_ID = "kingdamas-adsense";
let reusableWebAdBanner: HTMLElement | null = null;

function isNativeRuntime() {
  if (typeof window === "undefined") return false;
  const capacitor = (window as Window & {
    Capacitor?: {
      getPlatform?: () => string;
      isNativePlatform?: () => boolean;
    };
  }).Capacitor;
  return Boolean(
    capacitor?.isNativePlatform?.() || ["ios", "android"].includes(capacitor?.getPlatform?.() || ""),
  );
}

export function isBoardScreenPath(path: string) {
  return /^\/partida\/\d+$/.test(path)
    || /^\/leyenda\/[a-z]+\/(10|30|60)$/.test(path)
    || /^\/espectar\/\d+$/.test(path);
}

export function shouldShowWebAd(path: string, premium: boolean) {
  return !premium && !isNativeRuntime() && !isBoardScreenPath(path);
}

export function webAdBannerMarkup() {
  const developmentTestMode = import.meta.env.PROD ? "" : ' data-adtest="on"';
  return `<aside class="web-ad-banner" data-web-ad-banner aria-label="Publicidad"><ins class="adsbygoogle" style="display:block" data-ad-client="${ADSENSE_CLIENT}" data-ad-slot="${ADSENSE_SLOT}" data-ad-format="auto" data-full-width-responsive="true"${developmentTestMode}></ins></aside>`;
}

function ensureAdsenseScript() {
  if (document.getElementById(ADSENSE_SCRIPT_ID)) return;
  const existing = document.querySelector<HTMLScriptElement>(
    `script[src*="pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"]`,
  );
  if (existing) {
    existing.id ||= ADSENSE_SCRIPT_ID;
    return;
  }
  const script = document.createElement("script");
  script.id = ADSENSE_SCRIPT_ID;
  script.async = true;
  script.crossOrigin = "anonymous";
  script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}`;
  document.head.append(script);
}

function requestAd(banner: HTMLElement) {
  const unit = banner.querySelector<HTMLElement>(".adsbygoogle");
  if (!unit || unit.dataset.webAdRequested === "true") return;
  unit.dataset.webAdRequested = "true";
  try {
    const adsWindow = window as Window & {
      adsbygoogle?: Array<Record<string, never>>;
    };
    (adsWindow.adsbygoogle ||= []).push({});
  } catch (error) {
    delete unit.dataset.webAdRequested;
    console.warn("Google Ads todavía no está disponible.", error);
  }
}

export function removeWebAdBanner() {
  if (typeof document === "undefined") return;
  document.querySelectorAll("[data-web-ad-banner]").forEach((banner) => banner.remove());
}

export function syncWebAdBanner(path: string, premium: boolean) {
  if (typeof document === "undefined" || !shouldShowWebAd(path, premium)) {
    removeWebAdBanner();
    return;
  }

  const appRoot = document.querySelector<HTMLElement>("#app");
  if (!appRoot) return;
  let banner = appRoot.querySelector<HTMLElement>("[data-web-ad-banner]");
  if (!banner) {
    banner = reusableWebAdBanner;
    if (!banner) {
      const template = document.createElement("template");
      template.innerHTML = webAdBannerMarkup();
      banner = template.content.firstElementChild as HTMLElement | null;
    }
    if (!banner) return;
    reusableWebAdBanner = banner;

    const appContent = appRoot.querySelector<HTMLElement>(".app-content");
    const publicMain = appRoot.querySelector<HTMLElement>(".landing > main");
    if (appContent) appContent.prepend(banner);
    else if (publicMain) publicMain.before(banner);
    else appRoot.prepend(banner);
  }

  ensureAdsenseScript();
  requestAd(banner);
}
