export const LEGENDS = [
  {
    key: "facil",
    name: "Nara del Alba",
    epithet: "La Exploradora",
    difficulty: "Iniciación",
    level: 1,
    rating: 550,
    sigil: "N",
    accent: "#72d7a7",
    description: "Juega de forma directa y deja oportunidades claras para aprender.",
    ai: { depth: 0, candidatePool: 99, nodeBudget: 250, thinkTimeMs: 280 },
  },
  {
    key: "aprendiz",
    name: "Tomás del Roble",
    epithet: "El Guardián",
    difficulty: "Aprendiz",
    level: 2,
    rating: 800,
    sigil: "T",
    accent: "#8fca77",
    description: "Protege sus fichas y reconoce las capturas más evidentes.",
    ai: { depth: 1, candidatePool: 4, nodeBudget: 700, thinkTimeMs: 340 },
  },
  {
    key: "normal",
    name: "Amara del Río",
    epithet: "La Calculadora",
    difficulty: "Intermedio",
    level: 3,
    rating: 1050,
    sigil: "A",
    accent: "#63bfc2",
    description: "Valora material, avance y control del centro antes de actuar.",
    ai: { depth: 1, candidatePool: 2, nodeBudget: 1_500, thinkTimeMs: 400 },
  },
  {
    key: "competente",
    name: "Darío Centinela",
    epithet: "El Táctico",
    difficulty: "Competente",
    level: 4,
    rating: 1300,
    sigil: "D",
    accent: "#6fa6dd",
    description: "Anticipa respuestas y castiga fichas expuestas en combinaciones cortas.",
    ai: { depth: 2, candidatePool: 2, nodeBudget: 4_000, thinkTimeMs: 460 },
  },
  {
    key: "avanzado",
    name: "Selene de Hierro",
    epithet: "La Estratega",
    difficulty: "Avanzado",
    level: 5,
    rating: 1550,
    sigil: "S",
    accent: "#9b8bdf",
    description: "Construye posiciones sólidas y rara vez concede una ventaja sencilla.",
    ai: { depth: 2, candidatePool: 1, nodeBudget: 8_000, thinkTimeMs: 520 },
  },
  {
    key: "veterano",
    name: "Gael del Norte",
    epithet: "El Veterano",
    difficulty: "Veterano",
    level: 6,
    rating: 1800,
    sigil: "G",
    accent: "#c383d2",
    description: "Lee secuencias tácticas profundas y domina los cambios de ritmo.",
    ai: { depth: 3, candidatePool: 1, nodeBudget: 18_000, thinkTimeMs: 580 },
  },
  {
    key: "experto",
    name: "Valeria Implacable",
    epithet: "La Gran Maestra",
    difficulty: "Experto",
    level: 7,
    rating: 2100,
    sigil: "V",
    accent: "#de7d8d",
    description: "Calcula variantes largas y convierte casi cualquier error en una derrota.",
    ai: { depth: 4, candidatePool: 1, nodeBudget: 38_000, thinkTimeMs: 650 },
  },
  {
    key: "maestro",
    name: "Aureliano Corona Eterna",
    epithet: "El Soberano",
    difficulty: "Legendario",
    level: 8,
    rating: 2400,
    sigil: "♛",
    accent: "#e8b85a",
    description: "La prueba final: precisión, paciencia y cálculo al límite del tablero.",
    ai: { depth: 5, candidatePool: 1, nodeBudget: 75_000, thinkTimeMs: 740 },
  },
] as const;

export type Legend = (typeof LEGENDS)[number];
export type LegendDifficultyKey = Legend["key"];

export function legendByKey(key: string): Legend | null {
  return LEGENDS.find((legend) => legend.key === key) || null;
}

export function legendIndex(key: LegendDifficultyKey): number {
  return LEGENDS.findIndex((legend) => legend.key === key);
}
