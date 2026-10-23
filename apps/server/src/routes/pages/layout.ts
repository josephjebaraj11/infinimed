import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

/**
 * Shared layout for server-rendered, patient-facing pages (hosted connect flow, sandbox login,
 * patient portal). No third-party assets: everything is inline so the pages work under a strict
 * Content-Security-Policy and leak nothing to external hosts.
 */

export type Branding = { display_name?: string; primary_color?: string; logo_url?: string; support_email?: string };

const SAFE_COLOR = /^#[0-9a-fA-F]{3,8}$/;

export function layout(opts: { title: string; branding?: Branding; body: HtmlEscapedString | Promise<HtmlEscapedString>; script?: string }) {
  const color = opts.branding?.primary_color && SAFE_COLOR.test(opts.branding.primary_color) ? opts.branding.primary_color : "#2f5bea";
  const name = opts.branding?.display_name ?? "InfiniMed";
  const logo = opts.branding?.logo_url && /^https:\/\//.test(opts.branding.logo_url) ? opts.branding.logo_url : null;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${opts.title} · ${name}</title>
<style>
:root { --brand: ${raw(color)}; --bg: #f6f7f9; --card: #fff; --text: #1b1f24; --muted: #5d6673; --border: #e2e5ea; --ok: #1d7a46; --bad: #b42318; --warn: #a15c07; }
@media (prefers-color-scheme: dark) { :root { --bg: #0f1216; --card: #171b21; --text: #e8ebef; --muted: #9aa3ae; --border: #2a3039; } }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); }
main { max-width: 560px; margin: 0 auto; padding: 32px 16px 64px; }
header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
header img { height: 32px; width: auto; }
header .name { font-weight: 600; font-size: 17px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 16px; }
h1 { font-size: 22px; margin: 0 0 6px; }
h2 { font-size: 15px; margin: 0 0 10px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
p { margin: 0 0 12px; color: var(--muted); }
input[type=search], input[type=text], input[type=password], select, textarea { width: 100%; padding: 11px 12px; border: 1px solid var(--border); border-radius: 8px; font: inherit; background: var(--card); color: var(--text); }
input:focus, select:focus, textarea:focus, button:focus-visible, a:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
button, .button { display: inline-block; border: 0; background: var(--brand); color: #fff; padding: 10px 16px; border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer; text-decoration: none; text-align: center; }
button.secondary, .button.secondary { background: transparent; color: var(--text); border: 1px solid var(--border); }
button.danger { background: var(--bad); }
.list { list-style: none; margin: 0; padding: 0; }
.list li { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-top: 1px solid var(--border); }
.list li:first-child { border-top: 0; }
.list .logo { width: 36px; height: 36px; border-radius: 8px; background: var(--bg); display: grid; place-items: center; font-weight: 700; color: var(--muted); flex: none; overflow: hidden; }
.list .logo img { width: 100%; height: 100%; object-fit: contain; }
.list .meta { flex: 1; min-width: 0; }
.list .meta strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list .meta span { color: var(--muted); font-size: 13px; }
.chip { font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; border: 1px solid currentColor; }
.chip.ok { color: var(--ok); } .chip.bad { color: var(--bad); } .chip.warn { color: var(--warn); }
.notice { border-radius: 8px; padding: 10px 12px; margin-bottom: 16px; border: 1px solid var(--border); }
.notice.ok { border-color: var(--ok); color: var(--ok); } .notice.bad { border-color: var(--bad); color: var(--bad); }
.row { display: flex; gap: 8px; justify-content: space-between; align-items: center; flex-wrap: wrap; }
.muted { color: var(--muted); font-size: 13px; }
label { display: block; font-weight: 600; margin: 12px 0 6px; }
footer { text-align: center; color: var(--muted); font-size: 12px; margin-top: 24px; }
</style>
</head>
<body>
<main>
<header>${logo ? html`<img src="${logo}" alt="">` : ""}<span class="name">${name}</span></header>
${opts.body}
<footer>Secured by InfiniMed. Your portal password is never shared with ${name}.</footer>
</main>
${opts.script ? html`<script>${raw(opts.script)}</script>` : ""}
</body>
</html>`;
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export const CSP = "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'; connect-src 'self'";
