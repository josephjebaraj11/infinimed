import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { ErrorBox, useAction } from "../components";
import { useSession } from "../session";

export function Login({ onDone }: { onDone: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const action = useAction();
  const [params] = useSearchParams();
  const invite = params.get("token");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await action.run(async () => {
      await api("/auth/login", { body: { email, password } });
      if (invite) await api(`/invitations/${invite}/accept`, { body: {} });
      return true;
    });
    if (ok) await onDone();
  };
  return (
    <div className="auth-wrap">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand" style={{ padding: 0, marginBottom: 12 }}>
          <span className="brand-mark" aria-hidden /> InfiniMed
        </div>
        <h1>Sign in</h1>
        {invite && <p className="muted">Sign in to accept your workspace invitation.</p>}
        <ErrorBox error={action.error} />
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <div className="row" style={{ marginTop: 16 }}>
          <button type="submit" disabled={action.pending}>
            {action.pending ? "Signing in…" : "Sign in"}
          </button>
          <span className="spacer" />
          <Link to={`/signup${invite ? `?token=${invite}` : ""}`}>Create an account</Link>
        </div>
      </form>
    </div>
  );
}

export function Signup({ onDone }: { onDone: () => Promise<void> }) {
  const [form, setForm] = useState({ name: "", email: "", password: "", workspace_name: "", environment: "sandbox" });
  const action = useAction();
  const [params] = useSearchParams();
  const invite = params.get("token");
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await action.run(async () => {
      await api("/auth/signup", { body: { ...form, workspace_name: form.workspace_name || `${form.name || "My"} workspace` } });
      if (invite) await api(`/invitations/${invite}/accept`, { body: {} });
      return true;
    });
    if (ok) await onDone();
  };
  return (
    <div className="auth-wrap">
      <form className="card auth-card" onSubmit={submit}>
        <h1>Create your account</h1>
        <p className="muted">Start with a sandbox workspace: synthetic patients and vendor sandboxes, no PHI.</p>
        <ErrorBox error={action.error} />
        <label htmlFor="name">Your name</label>
        <input id="name" value={form.name} onChange={set("name")} autoComplete="name" />
        <label htmlFor="email">Work email</label>
        <input id="email" type="email" value={form.email} onChange={set("email")} autoComplete="email" required />
        <label htmlFor="password">Password</label>
        <input id="password" type="password" value={form.password} onChange={set("password")} autoComplete="new-password" minLength={10} required />
        <div className="field-hint">At least 10 characters.</div>
        <label htmlFor="ws">Workspace name</label>
        <input id="ws" value={form.workspace_name} onChange={set("workspace_name")} placeholder="Acme Health" />
        <label htmlFor="env">Environment</label>
        <select id="env" value={form.environment} onChange={set("environment")}>
          <option value="sandbox">Sandbox (development, synthetic data)</option>
          <option value="production">Production (live credentials and patients)</option>
        </select>
        <div className="row" style={{ marginTop: 16 }}>
          <button type="submit" disabled={action.pending}>
            Create account
          </button>
          <span className="spacer" />
          <Link to="/">I have an account</Link>
        </div>
      </form>
    </div>
  );
}

export function AcceptInvite() {
  const [params] = useSearchParams();
  const { refresh } = useSession();
  const navigate = useNavigate();
  const action = useAction();
  const token = params.get("token");
  return (
    <div className="card">
      <h2>Join workspace</h2>
      <ErrorBox error={action.error} />
      <button
        disabled={!token || action.pending}
        onClick={async () => {
          const ok = await action.run(() => api(`/invitations/${token}/accept`, { body: {} }));
          if (ok) {
            await refresh();
            navigate("/");
          }
        }}
      >
        Accept invitation
      </button>
    </div>
  );
}
