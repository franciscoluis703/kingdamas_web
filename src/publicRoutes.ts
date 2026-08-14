import type { AppLanguage } from "./i18n";

export const PUBLIC_CONTENT_PATHS = [
  "/como-jugar",
  "/acerca-de",
  "/contacto",
  "/seguridad-y-edad",
  "/politica-de-cookies",
  "/terminos-y-condiciones",
  "/politica-de-privacidad",
] as const;

export type PublicContentPath = (typeof PUBLIC_CONTENT_PATHS)[number];

interface PageMetadata {
  title: string;
  description: string;
}

const pageMetadata: Record<"/" | PublicContentPath, Record<AppLanguage, PageMetadata>> = {
  "/": {
    es: {
      title: "Juega Damas Internacionales en Tablero 10×10 | King Damas",
      description: "Compite en damas internacionales sobre un tablero 10×10, desafía jugadores de todo el mundo, mejora tu Elo y participa en partidas y torneos online.",
    },
    en: {
      title: "Play International Draughts on a 10×10 Board | King Damas",
      description: "Play international draughts on a 10×10 board, challenge players worldwide, improve your Elo, and join online matches and tournaments.",
    },
  },
  "/como-jugar": {
    es: {
      title: "Cómo jugar damas internacionales 10×10 | King Damas",
      description: "Aprende las reglas de las damas internacionales 10×10: tablero, capturas obligatorias, coronación, dama voladora y formas de ganar.",
    },
    en: {
      title: "How to Play 10×10 International Draughts | King Damas",
      description: "Learn 10×10 international draughts rules: the board, mandatory captures, promotion, flying kings and how to win a match.",
    },
  },
  "/acerca-de": {
    es: {
      title: "Acerca de King Damas | Damas internacionales 10×10",
      description: "Conoce King Damas, una comunidad para competir, aprender y disfrutar partidas de damas internacionales 10×10 en línea.",
    },
    en: {
      title: "About King Damas | 10×10 International Draughts",
      description: "Meet King Damas, a community to compete, learn and enjoy 10×10 international draughts matches online.",
    },
  },
  "/contacto": {
    es: {
      title: "Contacto y soporte | King Damas",
      description: "Contacta a King Damas para recibir ayuda con tu cuenta, partidas, privacidad o convivencia dentro de la comunidad.",
    },
    en: {
      title: "Contact and Support | King Damas",
      description: "Contact King Damas for help with your account, matches, privacy or community conduct.",
    },
  },
  "/seguridad-y-edad": {
    es: {
      title: "Seguridad y edad recomendada (13+) | King Damas",
      description: "Consulta la edad recomendada, las funciones sociales, el chat, la publicidad, las compras y las pautas de seguridad de King Damas.",
    },
    en: {
      title: "Safety and Age Suitability (13+) | King Damas",
      description: "Review King Damas age suitability, social features, chat, advertising, purchases, and safety guidance.",
    },
  },
  "/politica-de-cookies": {
    es: {
      title: "Política de cookies | King Damas",
      description: "Consulta qué almacenamiento esencial utiliza King Damas para mantener tu sesión y recordar tus preferencias de juego.",
    },
    en: {
      title: "Cookie Policy | King Damas",
      description: "Learn which essential storage King Damas uses to maintain your session and remember your game preferences.",
    },
  },
  "/terminos-y-condiciones": {
    es: {
      title: "Términos y condiciones | King Damas",
      description: "Consulta las reglas de uso, juego limpio, cuentas, torneos y convivencia aplicables en King Damas.",
    },
    en: {
      title: "Terms and Conditions | King Damas",
      description: "Read the rules for use, fair play, accounts, tournaments and community conduct on King Damas.",
    },
  },
  "/politica-de-privacidad": {
    es: {
      title: "Política de privacidad | King Damas",
      description: "Conoce cómo King Damas utiliza, protege y conserva los datos necesarios para operar cuentas, partidas y comunidad.",
    },
    en: {
      title: "Privacy Policy | King Damas",
      description: "Learn how King Damas uses, protects and retains the data required to operate accounts, matches and community features.",
    },
  },
};

export function normalizePublicPath(pathname: string) {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  return normalized;
}

export function isPublicContentPath(pathname: string): pathname is PublicContentPath {
  return PUBLIC_CONTENT_PATHS.includes(pathname as PublicContentPath);
}

export function resolveAppPath(pathname: string, hash: string) {
  const publicPath = normalizePublicPath(pathname);
  const hashPath = hash.replace(/^#/, "");
  if (hashPath && !(isPublicContentPath(publicPath) && !hashPath.startsWith("/"))) {
    return hashPath;
  }
  return isPublicContentPath(publicPath) ? publicPath : "/inicio";
}

export function publicPageMetadata(pathname: string, language: AppLanguage) {
  const path = normalizePublicPath(pathname);
  return pageMetadata[path as keyof typeof pageMetadata]?.[language] ?? pageMetadata["/"][language];
}
