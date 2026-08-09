const API_ORIGIN = "https://king-damas.68.183.58.56.nip.io";
const CANONICAL_ORIGIN = "https://kingdamas.com";
const ONE_YEAR_SECONDS = 31_536_000;
const ONE_WEEK_SECONDS = 604_800;
const ONE_MONTH_SECONDS = 2_592_000;

export function canonicalUrl(requestUrl) {
  const incoming = new URL(requestUrl);
  return new URL(`${incoming.pathname}${incoming.search}`, CANONICAL_ORIGIN);
}

export function upstreamUrl(requestUrl) {
  const incoming = new URL(requestUrl);
  const upstream = new URL(API_ORIGIN);
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;
  return upstream;
}

export function upstreamRequest(request) {
  const headers = new Headers(request.headers);
  // El navegador habla con el Worker en el mismo origen. Eliminar Origin
  // evita aplicar CORS dos veces al reenviar la petición al droplet.
  headers.delete("origin");
  return new Request(new Request(upstreamUrl(request.url), request), { headers });
}

export function assetCacheControl(pathname) {
  if (pathname.startsWith("/assets/")) {
    return `public, max-age=${ONE_YEAR_SECONDS}, immutable`;
  }
  if (
    pathname.startsWith("/audio/") ||
    pathname.startsWith("/brand/") ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/favicon-") ||
    pathname === "/apple-touch-icon.png" ||
    pathname === "/site.webmanifest"
  ) {
    return `public, max-age=${ONE_WEEK_SECONDS}, stale-while-revalidate=${ONE_MONTH_SECONDS}`;
  }
  return null;
}

export function withAssetCaching(response, pathname) {
  const cacheControl = assetCacheControl(pathname);
  if (!cacheControl || !response.ok) return response;
  const headers = new Headers(response.headers);
  headers.set("cache-control", cacheControl);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, environment) {
    const { hostname, pathname } = new URL(request.url);
    if (hostname === "www.kingdamas.com") {
      return Response.redirect(canonicalUrl(request.url), 308);
    }
    if (
      pathname === "/api" ||
      pathname.startsWith("/api/") ||
      pathname === "/socket.io" ||
      pathname.startsWith("/socket.io/")
    ) {
      return fetch(upstreamRequest(request));
    }
    const response = await environment.ASSETS.fetch(request);
    return withAssetCaching(response, pathname);
  },
};
