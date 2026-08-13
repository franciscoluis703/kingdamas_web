import { describe, expect, it } from "vitest";
import { isBoardScreenPath, shouldShowWebAd, webAdBannerMarkup } from "./webAds";

describe("anuncios web", () => {
  it("excluye todas las pantallas que contienen un tablero activo", () => {
    expect(isBoardScreenPath("/partida/52")).toBe(true);
    expect(isBoardScreenPath("/leyenda/capablanca/30")).toBe(true);
    expect(isBoardScreenPath("/espectar/52")).toBe(true);
    expect(isBoardScreenPath("/jugar")).toBe(false);
    expect(isBoardScreenPath("/leyendas/30")).toBe(false);
  });

  it("oculta el anuncio a una cuenta Premium", () => {
    expect(shouldShowWebAd("/inicio", true)).toBe(false);
    expect(shouldShowWebAd("/inicio", false)).toBe(true);
  });

  it("usa el cliente y el bloque responsive entregados", () => {
    const markup = webAdBannerMarkup();
    expect(markup).toContain('data-ad-client="ca-pub-3889117121292163"');
    expect(markup).toContain('data-ad-slot="2125052107"');
    expect(markup).toContain('data-full-width-responsive="true"');
  });
});
