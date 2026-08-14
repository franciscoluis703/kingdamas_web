import { describe, expect, it } from "vitest";
import { nativeStoreCatalog, type NativeStoreProduct } from "./nativeStore";

describe("catálogo de la tienda móvil", () => {
  it("conserva todos los productos configurados aunque la tienda todavía no devuelva alguno", () => {
    const configured = [
      { productId: "support.small", tier: "small" },
      { productId: "support.medium", tier: "medium" },
      { productId: "support.large", tier: "large" },
    ] as const;
    const available: NativeStoreProduct[] = [{
      id: "support.small",
      displayName: "Apoyo pequeño",
      description: "",
      displayPrice: "$2.99",
      price: 2.99,
      currencyCode: "USD",
      type: "Consumable",
    }];

    const catalog = nativeStoreCatalog(configured, available);

    expect(catalog).toHaveLength(3);
    expect(catalog[0]?.product?.displayPrice).toBe("$2.99");
    expect(catalog.slice(1).every((item) => item.product === null)).toBe(true);
  });
});
