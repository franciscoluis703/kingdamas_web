const API_ORIGIN = "https://king-damas.68.183.58.56.nip.io";
const CANONICAL_ORIGIN = "https://kingdamas.com";
const ONE_YEAR_SECONDS = 31_536_000;
const ONE_WEEK_SECONDS = 604_800;
const ONE_MONTH_SECONDS = 2_592_000;
const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

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

export function invitationTokenFromUrl(requestUrl) {
  const token = new URL(requestUrl).searchParams.get("invitacion");
  return token && INVITATION_TOKEN_PATTERN.test(token) ? token : null;
}

export function invitationPreviewImageUrl(token) {
  return `${CANONICAL_ORIGIN}/api/link-invitations/${encodeURIComponent(token)}/preview.jpg`;
}

export async function withInvitationMetadata(response, requestUrl, token) {
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) {
    return response;
  }
  const incoming = new URL(requestUrl);
  const shareUrl = new URL(incoming.pathname, CANONICAL_ORIGIN);
  shareUrl.searchParams.set("invitacion", token);
  const imageUrl = invitationPreviewImageUrl(token);
  const metadata = `
    <meta property="og:type" content="website" />
    <meta property="og:locale" content="es_DO" />
    <meta property="og:site_name" content="King Damas" />
    <meta property="og:title" content="¿Te atreves a aceptar este desafío?" />
    <meta property="og:description" content="Te esperan en una mesa 10×10. Acepta el duelo y demuestra quién merece la corona." />
    <meta property="og:url" content="${shareUrl.toString()}" />
    <meta property="og:image" content="${imageUrl}" />
    <meta property="og:image:secure_url" content="${imageUrl}" />
    <meta property="og:image:type" content="image/jpeg" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="Invitación personal a una partida de King Damas" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="¿Te atreves a aceptar este desafío?" />
    <meta name="twitter:description" content="Acepta el duelo 10×10 y demuestra quién merece la corona." />
    <meta name="twitter:image" content="${imageUrl}" />`;
  const html = (await response.text())
    .replace(/\s*<meta\s+property=["']og:image["'][^>]*>/i, "")
    .replace("</head>", `${metadata}\n  </head>`);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("cache-control", "private, no-store");
  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
    const invitationToken = invitationTokenFromUrl(request.url);
    if (invitationToken) {
      return withInvitationMetadata(
        response,
        request.url,
        invitationToken,
      );
    }
    return withAssetCaching(response, pathname);
  },
};
