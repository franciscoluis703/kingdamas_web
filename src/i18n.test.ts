import { describe, expect, it } from "vitest";
import { localeCode, normalizeLanguage, translateText } from "./i18n";

describe("preferencia de idioma", () => {
  it("acepta variantes regionales de español e inglés", () => {
    expect(normalizeLanguage("es-DO")).toBe("es");
    expect(normalizeLanguage("EN_us")).toBe("en");
    expect(normalizeLanguage("fr")).toBe("es");
  });

  it("expone la configuración regional correcta", () => {
    expect(localeCode("es")).toBe("es-DO");
    expect(localeCode("en")).toBe("en-US");
  });

  it("traduce textos fijos y dinámicos sin tocar nombres", () => {
    expect(translateText("Ver historial", "en")).toBe("View history");
    expect(translateText("10 partidas mostradas", "en")).toBe("10 matches shown");
    expect(translateText("Francisco", "en")).toBe("Francisco");
  });
});
