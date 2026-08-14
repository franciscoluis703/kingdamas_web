import { describe, expect, it } from "vitest";
import { resolveAppPath } from "./publicRoutes";

describe("rutas públicas con secciones", () => {
  it("mantiene la política de privacidad al abrir el ancla de eliminación", () => {
    expect(resolveAppPath(
      "/politica-de-privacidad",
      "#eliminar-cuenta",
    )).toBe("/politica-de-privacidad");
  });

  it("conserva las rutas internas que comienzan con una barra", () => {
    expect(resolveAppPath("/", "#/jugar")).toBe("/jugar");
    expect(resolveAppPath(
      "/politica-de-privacidad",
      "#/terminos-y-condiciones",
    )).toBe("/terminos-y-condiciones");
  });
});
