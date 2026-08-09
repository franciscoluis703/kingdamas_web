import { describe, expect, it } from "vitest";
import worker, {
  assetCacheControl,
  canonicalUrl,
  invitationPreviewImageUrl,
  invitationTokenFromUrl,
  upstreamRequest,
  upstreamUrl,
  withInvitationMetadata,
  withAssetCaching,
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
  });
});
