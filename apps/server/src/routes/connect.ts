import { Hono } from "hono";
import { html } from "hono/html";
import { config } from "../config.js";
import { ApiError } from "../lib/errors.js";
import { errorFields, log } from "../lib/logger.js";
import type { AppEnv, Ctx } from "../http/context.js";
import { handleCallback, startAuthorization } from "../services/patient-access.js";
import { buildReturnUrl, completeSession, findSessionByToken, sessionConnections } from "../services/sessions.js";
import { isConnectable } from "../services/credentials.js";
import { retrieveSource, searchSources, sourcesByIds } from "../services/sources.js";
import { effectiveSessionStatus } from "../services/serializers.js";
import { CSP, initials, layout, type Branding } from "./pages/layout.js";

/**
 * Hosted patient-facing flow.
 *   GET  /connect/{token}            hosted search page (hosted mode)
 *   GET  /connect/{token}/start      direct mode: straight to the portal sign-in
 *   GET  /connect/{token}/sources    JSON search used by the page's script
 *   POST /connect/{token}/authorize  start authorization for the chosen source
 *   POST /connect/{token}/complete   finish: completion screen with the return button
 *   GET  /oauth/callback             OAuth redirect URI registered with every source
 */

const FRIENDLY: Record<string, string> = {
  user_denied: "You cancelled the connection at the portal.",
  oauth_error: "The portal returned an error. Please try again.",
  token_exchange_failed: "The portal approved access but we could not finish connecting. Please try again.",
  no_patient_context: "The portal did not say whose records were shared. Please try again.",
  oauth_state_expired: "This sign-in took too long. Please start again.",
};

export function connectRouter() {
  const r = new Hono<AppEnv>();
  const pageHeaders = async (c: Ctx, next: () => Promise<void>) => {
    await next();
    c.header("Content-Security-Policy", CSP);
    c.header("Cache-Control", "no-store");
  };
  r.use("/connect/*", pageHeaders);
  r.use("/oauth/callback", pageHeaders);

  const errorPage = (title: string, message: string, branding?: Branding) =>
    layout({ title, branding, body: html`<div class="card"><h1>${title}</h1><p>${message}</p></div>` });

  const loadSession = async (token: string) => {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    return findSessionByToken(token);
  };

  r.get("/connect/:token", async (c) => {
    const token = c.req.param("token");
    const ctx = await loadSession(token);
    if (!ctx) return c.html(errorPage("Link not found", "This connection link is invalid. Ask the app that sent you here for a new one."), 404);
    const { session, workspace: ws } = ctx;
    const branding = ws.branding as Branding;
    if (effectiveSessionStatus(session) === "expired") return c.html(errorPage("Link expired", "This connection link has expired. Return to the app and start again.", branding), 410);
    if (session.mode === "direct") return c.redirect(`/connect/${token}/start`, 302);

    const connected = await sessionConnections(session.id);
    const q = c.req.query("q") ?? "";
    const recommended = session.recommendedSourceIds?.length ? await sourcesByIds(session.recommendedSourceIds) : [];
    const results = q.trim().length >= 2 ? (await searchSources(ws, { q, surface: "patient_access", limit: 25, includeConnectable: true })).data.filter((s) => s.connectable) : [];
    const justConnected = c.req.query("connected");
    const failed = c.req.query("failed");
    const error = c.req.query("error");
    const failedSource = failed ? (await sourcesByIds([failed]))[0] : undefined;
    const doneLabel = session.status === "complete" ? "Return" : "Done";

    const sourceItem = (s: { id: string; name: string; logo_url?: string | null; logoUrl?: string | null; city?: string | null; state?: string | null; type?: string; vendor?: string }) => {
      const logo = s.logo_url ?? s.logoUrl;
      return html`<li>
        <div class="logo">${logo ? html`<img src="${logo}" alt="">` : initials(s.name)}</div>
        <div class="meta"><strong>${s.name}</strong><span>${[s.city, s.state].filter(Boolean).join(", ")}</span></div>
        <form method="post" action="/connect/${token}/authorize"><input type="hidden" name="source_id" value="${s.id}"><button type="submit">Connect</button></form>
      </li>`;
    };

    const recommendedConnectable = [];
    for (const s of recommended) if (await isConnectable(ws.id, s.vendor, ws.environment)) recommendedConnectable.push(s);

    const body = html`
      ${justConnected ? html`<div class="notice ok" role="status">Connected. Your records will appear shortly. You can connect another facility or finish.</div>` : ""}
      ${failed ? html`<div class="notice bad" role="alert">${failedSource?.name ?? "That facility"}: ${FRIENDLY[error ?? ""] ?? FRIENDLY.oauth_error}</div>` : ""}
      <div class="card">
        <h1>Connect your health records</h1>
        <p>Find the hospital, clinic or insurer where you receive care, then sign in to its patient portal to share your records with ${(branding.display_name ?? "this app")}.</p>
        <form method="get" action="/connect/${token}" role="search">
          <input type="search" name="q" id="q" value="${q}" placeholder="Search by hospital, clinic or insurer name" autocomplete="off" aria-label="Search facilities" autofocus>
        </form>
        <ul class="list" id="results" aria-live="polite">${results.map((s) => sourceItem(s))}</ul>
        ${q.trim().length >= 2 && results.length === 0 ? html`<p class="muted" id="empty">No matching facilities. Try a shorter name or the name of the health system.</p>` : ""}
      </div>
      ${recommendedConnectable.length
        ? html`<div class="card"><h2>Suggested for you</h2><ul class="list">${recommendedConnectable.map((s) => sourceItem({ ...s, logo_url: s.logoUrl }))}</ul></div>`
        : ""}
      ${connected.length
        ? html`<div class="card"><h2>In this session</h2><ul class="list">${connected.map(
            ({ connection, source }) => html`<li>
              <div class="logo">${source?.logoUrl ? html`<img src="${source.logoUrl}" alt="">` : initials(source?.name ?? "?")}</div>
              <div class="meta"><strong>${source?.name ?? connection.sourceId}</strong><span>${connection.status === "active" ? "Connected" : FRIENDLY[connection.failureCode ?? ""] ?? "Not connected"}</span></div>
              <span class="chip ${connection.status === "active" ? "ok" : "bad"}">${connection.status === "active" ? "Connected" : "Failed"}</span>
            </li>`,
          )}</ul></div>`
        : ""}
      <form method="post" action="/connect/${token}/complete" class="row">
        <span class="muted">${connected.some((x) => x.connection.status === "active") ? "Finished connecting?" : "You can come back later."}</span>
        <button type="submit" class="${connected.length ? "" : "secondary"}">${doneLabel}</button>
      </form>`;

    // Progressive enhancement: live search without a full page load.
    const script = `
      (function(){
        var input=document.getElementById('q'), list=document.getElementById('results'), t;
        if(!input||!list) return;
        function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];});}
        input.addEventListener('input', function(){
          clearTimeout(t); var q=input.value.trim();
          t=setTimeout(function(){
            if(q.length<2){ list.innerHTML=''; return; }
            fetch('/connect/${token}/sources?q='+encodeURIComponent(q),{headers:{Accept:'application/json'}}).then(function(r){return r.json();}).then(function(j){
              var e=document.getElementById('empty'); if(e) e.remove();
              list.innerHTML=(j.data||[]).map(function(s){
                var logo=s.logo_url?'<img src="'+esc(s.logo_url)+'" alt="">':esc((s.name||'?').split(/\\s+/).slice(0,2).map(function(w){return w[0]}).join('').toUpperCase());
                var loc=[s.city,s.state].filter(Boolean).join(', ');
                return '<li><div class="logo">'+logo+'</div><div class="meta"><strong>'+esc(s.name)+'</strong><span>'+esc(loc)+'</span></div><form method="post" action="/connect/${token}/authorize"><input type="hidden" name="source_id" value="'+esc(s.id)+'"><button type="submit">Connect</button></form></li>';
              }).join('') || '<li class="muted">No matching facilities.</li>';
            }).catch(function(){});
          },200);
        });
      })();`;
    return c.html(layout({ title: "Connect your records", branding, body, script }));
  });

  r.get("/connect/:token/sources", async (c) => {
    const ctx = await loadSession(c.req.param("token"));
    if (!ctx || effectiveSessionStatus(ctx.session) !== "open") return c.json({ data: [] }, 404);
    const q = (c.req.query("q") ?? "").slice(0, 100);
    if (q.trim().length < 2) return c.json({ data: [] });
    const result = await searchSources(ctx.workspace, { q, surface: "patient_access", limit: 25, includeConnectable: true });
    return c.json({ data: result.data.filter((s) => s.connectable).map((s) => ({ id: s.id, name: s.name, logo_url: s.logo_url, city: s.city, state: s.state, type: s.type })) });
  });

  const begin = async (c: Ctx, token: string, sourceId: string | null) => {
    const ctx = await loadSession(token);
    if (!ctx) return c.html(errorPage("Link not found", "This connection link is invalid."), 404);
    const { session, workspace: ws } = ctx;
    const branding = ws.branding as Branding;
    if (effectiveSessionStatus(session) !== "open") return c.html(errorPage("Link expired", "This connection link has expired or was already used. Return to the app and start again.", branding), 410);
    const id = sourceId ?? session.sourceId;
    if (!id) return c.redirect(`/connect/${token}`, 302);
    try {
      const source = await retrieveSource(ws, id);
      const url = await startAuthorization({ ws, session, source, sessionToken: token });
      return c.redirect(url, 302);
    } catch (err) {
      log.warn("could not start authorization", { session_id: session.id, ...errorFields(err) });
      const message = err instanceof ApiError ? err.message : "We could not reach this facility right now. Please try again in a moment.";
      if (session.mode === "direct") {
        await completeSession(session.id);
        return c.redirect(buildReturnUrl(session, ctx.patient.externalId, { success: false, error: err instanceof ApiError ? err.code : "oauth_error", errorDescription: message }), 302);
      }
      return c.html(errorPage("Could not connect", message, branding), 502);
    }
  };

  r.get("/connect/:token/start", (c) => begin(c, c.req.param("token"), null));

  r.post("/connect/:token/authorize", async (c) => {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(config().publicUrl).origin && origin !== "null") return c.text("Cross-site request rejected", 403);
    const form = await c.req.parseBody();
    const sourceId = typeof form.source_id === "string" ? form.source_id : null;
    if (!sourceId) return c.redirect(`/connect/${c.req.param("token")}`, 302);
    return begin(c, c.req.param("token"), sourceId);
  });

  r.post("/connect/:token/complete", async (c) => {
    const token = c.req.param("token");
    const ctx = await loadSession(token);
    if (!ctx) return c.html(errorPage("Link not found", "This connection link is invalid."), 404);
    const { session, workspace: ws, patient } = ctx;
    const branding = ws.branding as Branding;
    await completeSession(session.id);
    const connected = (await sessionConnections(session.id)).filter((x) => x.connection.status === "active");
    const returnTo = buildReturnUrl(session, patient.externalId);
    const label = session.returnButtonLabel ?? `Back to ${branding.display_name ?? "the app"}`;
    return c.html(
      layout({
        title: "All set",
        branding,
        body: html`<div class="card">
          <h1>${connected.length ? "You're connected" : "Nothing was connected"}</h1>
          <p>${connected.length ? `Your records from ${connected.map((x) => x.source?.name ?? "your facility").join(", ")} will appear in the app shortly.` : "You can connect a facility any time from the app."}</p>
          <a class="button" href="${returnTo}">${label}</a>
        </div>`,
      }),
    );
  });

  r.get("/oauth/callback", async (c) => {
    try {
      const outcome = await handleCallback(new URL(c.req.url).searchParams);
      if (outcome.error || !outcome.redirectTo) {
        return c.html(errorPage("Could not connect", FRIENDLY[outcome.error?.code ?? ""] ?? outcome.error?.description ?? "Something went wrong."), 400);
      }
      return c.redirect(outcome.redirectTo, 302);
    } catch (err) {
      log.error("oauth callback failed", errorFields(err));
      return c.html(errorPage("Could not connect", "Something went wrong while finishing the connection. Please try again."), 500);
    }
  });

  return r;
}
