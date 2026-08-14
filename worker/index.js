const API_ORIGIN = "https://king-damas.68.183.58.56.nip.io";
const CANONICAL_ORIGIN = "https://kingdamas.com";
const ONE_YEAR_SECONDS = 31_536_000;
const ONE_WEEK_SECONDS = 604_800;
const ONE_MONTH_SECONDS = 2_592_000;
const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const SEO_IMAGE_URL = `${CANONICAL_ORIGIN}/brand/king-damas-logo.png`;
const SEO_PAGES = {
  "/": {
    title: "Juega Damas Internacionales en Tablero 10×10 | King Damas",
    description: "Compite en damas internacionales sobre un tablero 10×10, desafía jugadores de todo el mundo, mejora tu Elo y participa en partidas y torneos online.",
    heading: "Damas internacionales en tablero 10×10",
    body: `<p>Entra a una comunidad global de damas internacionales y disputa partidas en tiempo real sobre el tablero oficial de 10×10.</p><section><h2>Compite con jugadores de todo el mundo</h2><p>King Damas reúne partidas clasificadas, desafíos entre amigos, torneos y entrenamiento estratégico para todos los niveles.</p></section><section><h2>Domina cada movimiento del tablero</h2><p>Mejora tu Elo, practica capturas y coronaciones, y avanza en el Camino de Leyendas.</p></section><p><a href="/como-jugar">Aprende cómo jugar damas internacionales</a></p>`,
    lastmod: "2026-08-13",
    schemaType: "application",
  },
  "/como-jugar": {
    title: "Cómo jugar damas internacionales 10×10 | King Damas",
    description: "Aprende las reglas de las damas internacionales 10×10: tablero, capturas obligatorias, coronación, dama voladora y formas de ganar.",
    heading: "Cómo jugar damas internacionales 10×10",
    body: `<p>Cada jugador comienza con veinte fichas sobre las casillas oscuras de sus primeras cuatro filas; las dos filas centrales quedan libres.</p><section><h2>Capturas obligatorias</h2><p>Si existe una captura debes realizarla y elegir la secuencia que capture más fichas. Los saltos pueden encadenarse.</p></section><section><h2>Coronación y dama voladora</h2><p>Una ficha que alcanza la última fila se convierte en dama y puede desplazarse varias casillas por una diagonal.</p></section>`,
    lastmod: "2026-08-11",
    schemaType: "howto",
  },
  "/acerca-de": {
    title: "Acerca de King Damas | Damas internacionales 10×10",
    description: "Conoce King Damas, una comunidad para competir, aprender y disfrutar partidas de damas internacionales 10×10 en línea.",
    heading: "Acerca de King Damas",
    body: `<p>King Damas es una plataforma dedicada al tablero internacional 10×10 y creada para reunir competencia, aprendizaje y comunidad.</p><section><h2>Competición y aprendizaje</h2><p>Ofrece partidas clasificadas, Elo Damas, desafíos privados y un Camino de Leyendas para practicar sin afectar la clasificación.</p></section>`,
    lastmod: "2026-08-09",
  },
  "/contacto": {
    title: "Contacto y soporte | King Damas",
    description: "Contacta a King Damas para recibir ayuda con tu cuenta, partidas, privacidad o convivencia dentro de la comunidad.",
    heading: "Contacto y soporte",
    body: `<p>Escribe a <a href="mailto:admin@kingdamas.com">admin@kingdamas.com</a> para recibir ayuda con tu cuenta, partidas, privacidad o convivencia.</p><section><h2>Seguridad</h2><p>No envíes contraseñas, datos bancarios ni códigos de acceso por correo.</p></section>`,
    lastmod: "2026-08-09",
  },
  "/seguridad-y-edad": {
    title: "Seguridad y edad recomendada (13+) | King Damas",
    description: "Consulta la edad recomendada, las funciones sociales, el chat, la publicidad, las compras y las pautas de seguridad de King Damas.",
    heading: "Seguridad y edad recomendada: 13+",
    body: `<p>King Damas está clasificado 13+ por sus funciones sociales, la comunicación entre jugadores y las competiciones.</p><section><h2>Funciones sociales y comunicación</h2><p>Los usuarios pueden crear perfiles, descubrir y seguir jugadores, enviar mensajes privados y usar el chat de las partidas.</p></section><section><h2>Supervisión y contenido</h2><p>King Damas no incorpora verificación técnica de edad ni controles parentales propios. El juego oficial no contiene violencia, sexualidad, apuestas, cajas de recompensas, alcohol, drogas ni terror.</p></section><section><h2>Contacto de seguridad</h2><p>Para consultas de familias o reportes de seguridad, escribe a <a href="mailto:admin@kingdamas.com">admin@kingdamas.com</a>.</p></section>`,
    lastmod: "2026-08-13",
  },
  "/politica-de-cookies": {
    title: "Política de cookies | King Damas",
    description: "Consulta qué almacenamiento esencial utiliza King Damas para mantener tu sesión y recordar tus preferencias de juego.",
    heading: "Política de cookies",
    body: `<p>King Damas no utiliza cookies publicitarias ni de seguimiento. Emplea recursos esenciales para mantener la sesión y recordar preferencias locales de juego.</p>`,
    lastmod: "2026-08-09",
  },
  "/terminos-y-condiciones": {
    title: "Términos y condiciones | King Damas",
    description: "Consulta las reglas de uso, juego limpio, cuentas, torneos y convivencia aplicables en King Damas.",
    heading: "Términos y condiciones",
    body: `<p>El uso de King Damas requiere respetar el juego limpio, proteger las credenciales y evitar cualquier automatización, manipulación de resultados, acoso o conducta ilícita.</p>`,
    lastmod: "2026-08-09",
  },
  "/politica-de-privacidad": {
    title: "Política de privacidad | King Damas",
    description: "Conoce cómo King Damas utiliza, protege y conserva los datos necesarios para operar cuentas, partidas y comunidad.",
    heading: "Política de privacidad",
    body: `<p>King Damas utiliza los datos necesarios para operar cuentas, partidas y funciones comunitarias. No vende información personal.</p><section><h2>Responsable y contacto</h2><p>King Damas es responsable del tratamiento descrito en esta política. Para consultas o solicitudes de privacidad, escribe a <a href="mailto:admin@kingdamas.com">admin@kingdamas.com</a>.</p></section><section><h2>Datos que tratamos</h2><p>Podemos tratar datos de cuenta y perfil, historial de acceso, partidas, clasificaciones, amistades, mensajes, torneos, referencias de transacciones y datos técnicos necesarios para seguridad y diagnóstico. Los proveedores de publicidad móvil también pueden tratar identificadores del dispositivo, dirección IP, interacciones con anuncios y datos de diagnóstico según las opciones de privacidad del usuario.</p></section><section><h2>Finalidades</h2><p>Utilizamos la información para autenticar usuarios, operar partidas, clasificaciones y funciones comunitarias, gestionar compras y Premium, atender solicitudes, prevenir abuso y mantener el servicio.</p></section><section><h2>Proveedores</h2><p>Podemos utilizar proveedores de infraestructura, correo, compras mediante Apple y Google, pagos web mediante PayPal y publicidad mediante Google Mobile Ads. Solo se comparte la información necesaria para cada función.</p></section><section id="opciones-de-privacidad"><h2>Opciones y derechos</h2><p>Puedes modificar tus preferencias desde la aplicación y solicitar acceso, corrección, actualización o eliminación escribiendo desde el correo asociado a tu cuenta a <a href="mailto:admin@kingdamas.com">admin@kingdamas.com</a>.</p></section><section id="eliminar-cuenta"><h2>Eliminación de la cuenta</h2><p>Puedes iniciar la eliminación desde Configuración → Eliminar cuenta o solicitarla por correo. Eliminaremos o anonimizaremos los datos asociados salvo la información que debamos conservar temporalmente por seguridad, disputas de pagos u obligaciones legales.</p></section><section><h2>Menores y cambios</h2><p>King Damas está recomendado para personas de 13 años o más. Esta política está vigente desde el 13 de agosto de 2026 y sus actualizaciones se publicarán en esta página.</p></section>`,
    lastmod: "2026-08-13",
  },
};

export function normalizeSeoPath(pathname) {
  return pathname.replace(/\/+$/, "") || "/";
}

export function robotsText() {
  return `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /socket.io/\nDisallow: /*?invitacion=\n\nSitemap: ${CANONICAL_ORIGIN}/sitemap.xml\n`;
}

export function adsText() {
  return "google.com, pub-3889117121292163, DIRECT, f08c47fec0942fa0\n";
}

export function sitemapXml() {
  const urls = Object.entries(SEO_PAGES).map(([path, page]) => {
    const location = path === "/" ? `${CANONICAL_ORIGIN}/` : `${CANONICAL_ORIGIN}${path}`;
    return `  <url><loc>${location}</loc><lastmod>${page.lastmod}</lastmod></url>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function structuredData(path, page) {
  const url = path === "/" ? `${CANONICAL_ORIGIN}/` : `${CANONICAL_ORIGIN}${path}`;
  if (page.schemaType === "application") {
    return {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Organization", "@id": `${CANONICAL_ORIGIN}/#organization`, name: "King Damas", alternateName: "KingDamas.com", url: `${CANONICAL_ORIGIN}/`, logo: { "@type": "ImageObject", url: SEO_IMAGE_URL, contentUrl: SEO_IMAGE_URL, width: 1254, height: 1254 }, image: SEO_IMAGE_URL, email: "admin@kingdamas.com" },
        { "@type": "WebSite", "@id": `${CANONICAL_ORIGIN}/#website`, url, name: "King Damas", alternateName: "KingDamas.com", inLanguage: ["es", "en"], publisher: { "@id": `${CANONICAL_ORIGIN}/#organization` } },
        { "@type": ["VideoGame", "WebApplication"], "@id": `${CANONICAL_ORIGIN}/#application`, name: "King Damas", url, description: page.description, applicationCategory: "GameApplication", operatingSystem: "Web, iOS, Android", inLanguage: ["es", "en"], image: SEO_IMAGE_URL, publisher: { "@id": `${CANONICAL_ORIGIN}/#organization` }, offers: { "@type": "Offer", price: "0", priceCurrency: "USD" } },
      ],
    };
  }
  if (page.schemaType === "howto") {
    return {
      "@context": "https://schema.org",
      "@type": "HowTo",
      name: page.heading,
      description: page.description,
      url,
      step: [
        { "@type": "HowToStep", name: "Posición inicial", text: "Coloca veinte fichas por jugador en las casillas oscuras de las primeras cuatro filas." },
        { "@type": "HowToStep", name: "Capturas obligatorias", text: "Realiza una captura siempre que esté disponible y completa la secuencia correspondiente." },
        { "@type": "HowToStep", name: "Coronación", text: "Alcanza la última fila para convertir una ficha en dama voladora." },
      ],
    };
  }
  return { "@context": "https://schema.org", "@type": "WebPage", name: page.heading, description: page.description, url, isPartOf: { "@id": `${CANONICAL_ORIGIN}/#website` }, inLanguage: "es" };
}

function seoMetadata(path, page) {
  const url = path === "/" ? `${CANONICAL_ORIGIN}/` : `${CANONICAL_ORIGIN}${path}`;
  return `<!-- SEO_META_START -->
    <title>${page.title}</title>
    <meta name="description" content="${page.description}" />
    <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" />
    <link rel="canonical" href="${url}" />
    <meta property="og:type" content="website" />
    <meta property="og:locale" content="es_ES" />
    <meta property="og:locale:alternate" content="en_US" />
    <meta property="og:site_name" content="King Damas" />
    <meta property="og:title" content="${page.title}" />
    <meta property="og:description" content="${page.description}" />
    <meta property="og:url" content="${url}" />
    <meta property="og:image" content="${SEO_IMAGE_URL}" />
    <meta property="og:image:width" content="1254" />
    <meta property="og:image:height" content="1254" />
    <meta property="og:image:alt" content="Logo de King Damas inspirado en una ficha de tablero" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${page.title}" />
    <meta name="twitter:description" content="${page.description}" />
    <meta name="twitter:image" content="${SEO_IMAGE_URL}" />
    <script type="application/ld+json">${JSON.stringify(structuredData(path, page))}</script>
    <!-- SEO_META_END -->`;
}

function seoSnapshot(page) {
  return `<!-- SEO_FALLBACK_START --><div class="landing seo-fallback"><header class="public-header container"><a class="brand" href="/">King Damas</a><nav class="public-nav"><a href="/como-jugar">Cómo jugar</a><a href="/acerca-de">Acerca de</a></nav></header><main class="public-information-page container"><article><h1>${page.heading}</h1>${page.body}</article></main><footer class="public-footer container"><a href="/">King Damas</a><nav><a href="/contacto">Contacto</a><a href="/seguridad-y-edad">Seguridad y edad</a><a href="/terminos-y-condiciones">Términos</a><a href="/politica-de-privacidad">Privacidad</a></nav></footer></div><!-- SEO_FALLBACK_END -->`;
}

function replaceMetadata(html, metadata) {
  if (/<!-- SEO_META_START -->[\s\S]*?<!-- SEO_META_END -->/.test(html)) {
    return html.replace(/<!-- SEO_META_START -->[\s\S]*?<!-- SEO_META_END -->/, metadata);
  }
  return html.replace("</head>", `${metadata}\n  </head>`);
}

export async function withSeoPage(response, pathname) {
  const path = normalizeSeoPath(pathname);
  const page = SEO_PAGES[path];
  if (!page || !response.ok || !response.headers.get("content-type")?.includes("text/html")) return response;
  let html = replaceMetadata(await response.text(), seoMetadata(path, page));
  if (/<!-- SEO_FALLBACK_START -->[\s\S]*?<!-- SEO_FALLBACK_END -->/.test(html)) {
    html = html.replace(/<!-- SEO_FALLBACK_START -->[\s\S]*?<!-- SEO_FALLBACK_END -->/, seoSnapshot(page));
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-language", "es");
  headers.set("x-robots-tag", "index, follow");
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}

export async function withNoIndex(response) {
  if (!response.headers.get("content-type")?.includes("text/html")) return response;
  const metadata = `<!-- SEO_META_START -->
    <title>King Damas</title>
    <meta name="robots" content="noindex, nofollow, noarchive" />
    <!-- SEO_META_END -->`;
  const html = replaceMetadata(await response.text(), metadata);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}

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
  const metadata = `<!-- SEO_META_START -->
    <title>Desafío privado de damas 10×10 | King Damas</title>
    <meta name="robots" content="noindex, nofollow, noarchive" />
    <link rel="canonical" href="${shareUrl.toString()}" />
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
    <meta name="twitter:image" content="${imageUrl}" />
    <!-- SEO_META_END -->`;
  const html = replaceMetadata(
    (await response.text()).replace(/\s*<meta\s+property=["']og:image["'][^>]*>/i, ""),
    metadata,
  );
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("cache-control", "private, no-store");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
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
    if (pathname === "/robots.txt") {
      return new Response(robotsText(), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
    }
    if (pathname === "/ads.txt" || pathname === "/app-ads.txt") {
      return new Response(adsText(), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
    }
    if (pathname === "/sitemap.xml") {
      return new Response(sitemapXml(), { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
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
    const seoResponse = await withSeoPage(response, pathname);
    if (seoResponse !== response) return seoResponse;
    if (response.headers.get("content-type")?.includes("text/html")) {
      return withNoIndex(response);
    }
    return withAssetCaching(response, pathname);
  },
};
