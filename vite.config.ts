import { defineConfig, loadEnv, type ProxyOptions } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backend = env.VITE_BACKEND_URL || "https://king-damas.68.183.58.56.nip.io";
  const proxy: ProxyOptions = {
    target: backend,
    changeOrigin: true,
    secure: false,
    configure(proxyServer) {
      // El navegador habla con Vite en el mismo origen. No debemos reenviar
      // ese Origin local al backend público, cuya lista CORS es deliberadamente
      // restrictiva. La protección del navegador sigue aplicándose al proxy.
      proxyServer.on("proxyReq", (proxyRequest) => {
        proxyRequest.removeHeader("origin");
      });
      proxyServer.on("proxyReqWs", (proxyRequest) => {
        proxyRequest.removeHeader("origin");
      });
    },
  };

  return {
    server: {
      host: true,
      port: 5173,
      proxy: {
        "/api": proxy,
        "/socket.io": { ...proxy, ws: true },
      },
    },
    preview: { host: true, port: 4173 },
  };
});
