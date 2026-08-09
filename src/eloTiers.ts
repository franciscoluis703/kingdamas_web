export const ELO_TIERS = [
  { minimum: 0, maximum: 699, label: "Aprendiz" },
  { minimum: 700, maximum: 999, label: "Jugador" },
  { minimum: 1000, maximum: 1199, label: "Experto" },
  { minimum: 1200, maximum: 1399, label: "Candidato a Maestro" },
  { minimum: 1400, maximum: 1599, label: "Maestro" },
  { minimum: 1600, maximum: 1799, label: "Maestro Superior" },
  { minimum: 1800, maximum: 1999, label: "Maestro Élite" },
  { minimum: 2000, maximum: 2199, label: "Gran Maestro" },
  { minimum: 2200, maximum: null, label: "Gran Maestro Supremo" },
] as const;

export type EloTierLabel = (typeof ELO_TIERS)[number]["label"];

export function eloTier(rating: number): EloTierLabel {
  const normalized = Number.isFinite(rating) ? Math.max(0, Math.floor(rating)) : 0;
  return ELO_TIERS.find(
    (tier) => tier.maximum === null || normalized <= tier.maximum,
  )!.label;
}

export function eloTierRange(
  tier: (typeof ELO_TIERS)[number],
): string {
  return tier.maximum === null
    ? `${tier.minimum.toLocaleString("es-DO")}+`
    : `${tier.minimum.toLocaleString("es-DO")}–${tier.maximum.toLocaleString("es-DO")}`;
}
