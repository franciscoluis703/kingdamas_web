# King Damas Web

Frontend web responsive para jugar damas internacionales 10×10 contra otros jugadores en tiempo real.

## Tecnología

- TypeScript estricto y Vite.
- `cm-chessboard` como base del modelo de interacción responsive por puntero.
- Adaptador `CmCheckersboard` para las 100 casillas de damas 10×10.
- HTML y CSS nativos, sin framework de interfaz.
- Socket.IO para partidas, matchmaking y chat en vivo.

`cm-chessboard` fija internamente su tablero, FEN y coordenadas a 8×8. Por eso la integración 10×10 está aislada en `src/game/CmCheckersboard.ts`: conserva la separación entre vista e interacción de la librería, pero usa las coordenadas de damas que entiende el backend. El servidor siempre valida la jugada definitiva.

## Desarrollo

Requiere Node.js 20 o superior.

```bash
npm install
npm run dev
```

En desarrollo, Vite redirige `/api` y `/socket.io` al backend desplegado. Para indicar otra instancia, copia `.env.example` como `.env` y modifica:

```dotenv
VITE_API_URL=http://localhost:3000/api
VITE_SOCKET_URL=http://localhost:3000
```

Si frontend y backend se publican bajo el mismo dominio, ambas variables pueden quedar vacías para usar rutas relativas.

## Verificación

```bash
npm run typecheck
npm test
npm run build
```

La salida lista para producción queda en `dist/`.

## Estructura

```text
src/
├── api.ts                    Cliente HTTP tipado
├── config.ts                 URLs y modalidad admitida
├── game/
│   ├── CmCheckersboard.ts    Tablero responsive 10×10
│   ├── engine.ts             Movimientos legales en el cliente
│   └── engine.test.ts        Pruebas de reglas esenciales
├── main.ts                   Vistas, navegación y tiempo real
├── styles.css                Sistema visual responsive
├── types.ts                  Contratos compartidos
└── ui.ts                     Utilidades seguras de presentación
```

## Alcance funcional

- Registro, inicio y cierre de sesión.
- Elo Damas y clasificación nacional/mundial.
- Matchmaking clasificado 10×10 a 10, 30 o 60 minutos.
- Desafíos privados mediante enlaces que se pueden copiar o compartir.
- Partidas locales contra “La Leyenda”, con búsqueda de jugadas en el navegador.
- Tablero orientado al jugador, capturas múltiples y coronación.
- Relojes sincronizados con el servidor.
- Ofertas de tablas, retiro/rendición y chat de partida.
- Actualización por Socket.IO con sincronización HTTP de respaldo.

## Producción

El backend debe incluir el origen público del frontend en `CLIENT_ORIGINS`. La cookie de sesión requiere HTTPS cuando ambos servicios usan dominios distintos.

`cm-chessboard` se distribuye bajo licencia MIT. Consulta `node_modules/cm-chessboard/LICENSE` tras instalar dependencias.
