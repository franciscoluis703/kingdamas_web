import { describe, expect, it } from "vitest";
import worker, {
  assetCacheControl,
  canonicalUrl,
  invitationPreviewImageUrl,
  invitationTokenFromUrl,
  robotsText,
  sitemapXml,
  upstreamRequest,
  upstreamUrl,
  withInvitationMetadata,
  withAssetCaching,
  withNoIndex,
  withSeoPage,
} from "./index.js";

describe("proxy de Cloudflare", () => {
  it("conserva ruta y consulta al dirigir una petición hacia el droplet", () => {
    expect(
      upstreamUrl("https://kingdamas_web.example/api/auth/me?source=worker").toString(),
    ).toBe("https://king-damas.68.183.58.56.nip.io/api/auth/me?source=worker");
  });

  it("conserva la sesión y elimina el Origin antes de reenviar", () => {
    const request = new Request("https://kingdamas_web.example/api/auth/me", {
      headers: {
        Cookie: "king_damas_session=test-token",
        Origin: "https://kingdamas_web.example",
      },
    });
    const proxied = upstreamRequest(request);
    expect(proxied.headers.get("cookie")).toBe("king_damas_session=test-token");
    expect(proxied.headers.has("origin")).toBe(false);
  });

  it("envía www al dominio principal conservando ruta y consulta", async () => {
    expect(
      canonicalUrl("https://www.kingdamas.com/torneos?edicion=2027").toString(),
    ).toBe("https://kingdamas.com/torneos?edicion=2027");
    const response = await worker.fetch(
      new Request("https://www.kingdamas.com/torneos?edicion=2027"),
      {},
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      "https://kingdamas.com/torneos?edicion=2027",
    );
  });

  it("mantiene los recursos versionados en el navegador durante un año", () => {
    expect(assetCacheControl("/assets/index-test123.js")).toBe(
      "public, max-age=31536000, immutable",
    );
    const response = withAssetCaching(
      new Response("body", { headers: { "cache-control": "max-age=0" } }),
      "/assets/index-test123.js",
    );
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("no inmoviliza el documento principal en la caché del navegador", () => {
    expect(assetCacheControl("/")).toBeNull();
    expect(assetCacheControl("/index.html")).toBeNull();
  });

  it("reconoce únicamente tokens válidos de invitación", () => {
    const token = "abcdefghijklmnopqrstuvwxyzABCDEF";
    expect(invitationTokenFromUrl(`https://kingdamas.com/?invitacion=${token}`)).toBe(token);
    expect(invitationTokenFromUrl("https://kingdamas.com/?invitacion=corto")).toBeNull();
  });

  it("publica instrucciones de rastreo con el sitemap canónico", () => {
    expect(robotsText()).toContain("Allow: /");
    expect(robotsText()).toContain("Disallow: /api/");
    expect(robotsText()).toContain("Sitemap: https://kingdamas.com/sitemap.xml");
  });

  it("publica la autorización de Google para web y aplicaciones", async () => {
    const { adsText } = await import("./index.js");
    expect(adsText()).toBe(
      "google.com, pub-3889117121292163, DIRECT, f08c47fec0942fa0\n",
    );
  });

  it("genera un sitemap XML con las páginas públicas y sin rutas hash", () => {
    const sitemap = sitemapXml();
    expect(sitemap).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(sitemap).toContain("<loc>https://kingdamas.com/</loc>");
    expect(sitemap).toContain("<loc>https://kingdamas.com/como-jugar</loc>");
    expect(sitemap).toContain("<loc>https://kingdamas.com/seguridad-y-edad</loc>");
    expect(sitemap).toContain("<loc>https://kingdamas.com/politica-de-privacidad</loc>");
    expect(sitemap).not.toContain("#");
  });

  it("entrega contenido y metadatos rastreables para cada URL pública", async () => {
    const response = await withSeoPage(
      new Response('<html><head><!-- SEO_META_START --><!-- SEO_META_END --></head><body><div id="app"><!-- SEO_FALLBACK_START --><!-- SEO_FALLBACK_END --></div></body></html>', {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      "/como-jugar",
    );
    const html = await response.text();
    expect(html).toContain("Cómo jugar damas internacionales 10×10");
    expect(html).toContain('<link rel="canonical" href="https://kingdamas.com/como-jugar"');
    expect(html).toContain('type="application/ld+json"');
    expect(html).toContain("Capturas obligatorias");
    expect(response.headers.get("x-robots-tag")).toBe("index, follow");
  });

  it("publica la página de seguridad y edad con clasificación 13+", async () => {
    const response = await withSeoPage(
      new Response('<html><head><!-- SEO_META_START --><!-- SEO_META_END --></head><body><div id="app"><!-- SEO_FALLBACK_START --><!-- SEO_FALLBACK_END --></div></body></html>', {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      "/seguridad-y-edad",
    );
    const html = await response.text();
    expect(html).toContain("Seguridad y edad recomendada: 13+");
    expect(html).toContain('href="mailto:admin@kingdamas.com"');
    expect(html).toContain('<link rel="canonical" href="https://kingdamas.com/seguridad-y-edad"');
  });

  it("publica una política de privacidad accesible con opciones y eliminación", async () => {
    const response = await withSeoPage(
      new Response('<html><head><!-- SEO_META_START --><!-- SEO_META_END --></head><body><div id="app"><!-- SEO_FALLBACK_START --><!-- SEO_FALLBACK_END --></div></body></html>', {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      "/politica-de-privacidad",
    );
    const html = await response.text();
    expect(html).toContain("Política de privacidad");
    expect(html).toContain('id="opciones-de-privacidad"');
    expect(html).toContain('id="eliminar-cuenta"');
    expect(html).toContain("admin@kingdamas.com");
    expect(response.headers.get("x-robots-tag")).toBe("index, follow");
  });

  it("presenta la portada como una comunidad internacional y declara el logo oficial", async () => {
    const response = await withSeoPage(
      new Response('<html><head><!-- SEO_META_START --><!-- SEO_META_END --></head><body><div id="app"><!-- SEO_FALLBACK_START --><!-- SEO_FALLBACK_END --></div></body></html>', {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      "/",
    );
    const html = await response.text();
    expect(html).toContain("Damas internacionales en tablero 10×10");
    expect(html).toContain("jugadores de todo el mundo");
    expect(html).toContain('"@type":"Organization"');
    expect(html).toContain('"logo":{"@type":"ImageObject"');
    expect(html).toContain("https://kingdamas.com/brand/king-damas-logo.png");
    expect(html).not.toContain("República Dominicana");
  });

  it("marca como no indexables las rutas privadas o desconocidas", async () => {
    const response = await withNoIndex(
      new Response("<html><head></head><body></body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    expect(await response.text()).toContain("noindex, nofollow, noarchive");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
  });

  it("inyecta una tarjeta social personalizada en el enlace compartido", async () => {
    const token = "abcdefghijklmnopqrstuvwxyzABCDEF";
    const response = await withInvitationMetadata(
      new Response('<html><head><meta property="og:image" content="/brand/default.png" /></head><body></body></html>', {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      `https://kingdamas.com/?invitacion=${token}`,
      token,
    );
    const html = await response.text();
    expect(html).toContain("¿Te atreves a aceptar este desafío?");
    expect(html).toContain(invitationPreviewImageUrl(token));
    expect(html).toContain(`https://kingdamas.com/?invitacion=${token}`);
    expect(html).toContain("summary_large_image");
    expect(html).not.toContain("/brand/default.png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
  });
});
