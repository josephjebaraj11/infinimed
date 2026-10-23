import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { config } from "./config.js";
import type { AppEnv } from "./http/context.js";
import { errorResponse, requestId, securityHeaders } from "./http/middleware.js";
import { ApiError } from "./lib/errors.js";
import { publicJwks } from "./services/keys.js";
import { apiRouter } from "./routes/api.js";
import { connectRouter } from "./routes/connect.js";
import { clinicalRouter } from "./routes/clinical.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { internalFhirRouter } from "./routes/internal-fhir.js";
import { portalRouter } from "./routes/portal.js";
import { syntheticRouter } from "./synthetic/routes.js";
import { mcpOauthRouter } from "./mcp/oauth.js";
import { mcpRouter } from "./mcp/server.js";

/** Builds the HTTP application. Pure: no listening socket, no worker (see index.ts). */
export function createApp() {
  const app = new Hono<AppEnv>();
  app.use("*", requestId, securityHeaders);
  app.onError((err, c) => errorResponse(c, err));
  app.notFound((c) => c.json(new ApiError("resource_not_found", `No route for ${c.req.method} ${c.req.path}`).toEnvelope(c.get("requestId")), 404));

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/.well-known/jwks.json", async (c) => {
    c.header("Cache-Control", "public, max-age=300");
    return c.json(await publicJwks());
  });

  // Public API: server-to-server only. No CORS: API keys must never be used from browsers.
  app.route("/v1", apiRouter());

  // Dashboard API: credentialed CORS for the dashboard origin only (when served separately).
  app.use(
    "/dashboard-api/*",
    cors({
      origin: (origin) => (origin === config().dashboardUrl || origin === config().publicUrl ? origin : null),
      credentials: true,
      allowHeaders: ["Content-Type", "X-InfiniMed-CSRF", "X-Workspace-Id"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    }),
  );
  app.route("/dashboard-api", dashboardRouter());

  app.route("/", connectRouter());
  app.route("/", clinicalRouter());
  app.route("/", portalRouter());
  app.route("/", internalFhirRouter());
  app.route("/", syntheticRouter());
  app.route("/", mcpOauthRouter());
  app.route("/", mcpRouter());

  // Serve the built dashboard (apps/dashboard/dist) at /app when present, with SPA fallback.
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dashboard/dist");
  if (existsSync(dist)) {
    const indexHtml = readFileSync(path.join(dist, "index.html"), "utf8");
    app.use("/app/*", async (c, next) => {
      await next();
      c.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    });
    app.use("/app/*", serveStatic({ root: path.relative(process.cwd(), dist), rewriteRequestPath: (p) => p.replace(/^\/app/, "") }));
    app.get("/app/*", (c) => c.html(indexHtml));
    app.get("/", (c) => c.redirect("/app/", 302));
  }
  return app;
}
