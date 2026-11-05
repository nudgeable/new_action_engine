"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { ArrowRight, Eye, EyeOff, Loader2 } from "lucide-react";
import InstallAppButton from "@/components/InstallAppButton";
import { clearAdminBatchSelection } from "@/components/admin/AdminContext";

/** A learning note becomes action cards, a phone message nudges, a tap completes. */
function LoginStory() {
  return (
    <svg className="login-story" viewBox="0 0 560 265" role="img" aria-labelledby="login-story-title">
      <title id="login-story-title">
        A learning note becomes small action cards, a mobile message nudges you, and a tap marks the action complete.
      </title>
      <defs>
        <pattern id="login-story-dots" width="15" height="15" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="1.25" fill="#ae9ec2" opacity=".42" />
        </pattern>
      </defs>
      <rect x="4" y="27" width="550" height="219" rx="32" fill="url(#login-story-dots)" />
      <path d="M137 143C200 143 205 96 259 96m120 39c39 0 51 18 65 40" fill="none" stroke="#8a779e" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="3 8" />

      {/* One learning note becomes smaller actions. */}
      <g transform="rotate(-12 72 128)">
        <rect x="22" y="58" width="104" height="130" rx="14" fill="#dbccec" stroke="#28202d" strokeWidth="2" />
        <rect x="16" y="51" width="104" height="130" rx="14" fill="#fff" stroke="#28202d" strokeWidth="2" />
        <path d="M34 82h41m-41 18h66m-66 15h54m-54 15h61" stroke="#8c8092" strokeWidth="4" strokeLinecap="round" />
        <path d="M34 82h23" stroke="#f5b822" strokeWidth="5" strokeLinecap="round" />
      </g>
      <g stroke="#28202d" strokeWidth="2">
        <rect x="88" y="135" width="111" height="28" rx="8" fill="#fff4cf" />
        <rect x="103" y="170" width="111" height="28" rx="8" fill="#eee5fb" />
        <rect x="118" y="205" width="111" height="28" rx="8" fill="#fff" />
      </g>
      <path d="M101 149h6m8 0h58m-57 35h6m8 0h58m-57 35h6m8 0h58" stroke="#655771" strokeWidth="3" strokeLinecap="round" />

      {/* A message arrives on a phone. */}
      <rect x="268" y="25" width="120" height="208" rx="23" fill="#28202d" />
      <rect x="261" y="19" width="120" height="208" rx="23" fill="#fff" stroke="#28202d" strokeWidth="2" />
      <rect x="273" y="32" width="96" height="181" rx="14" fill="#ede4f7" />
      <path d="M310 42h22m-21 161h20" stroke="#28202d" strokeWidth="3" strokeLinecap="round" />
      <rect x="286" y="68" width="68" height="26" rx="8" fill="#fff" />
      <path d="M298 81h37" stroke="#9d8eaa" strokeWidth="3" strokeLinecap="round" />
      <rect x="294" y="106" width="128" height="56" rx="12" fill="#e4f5e9" stroke="#28202d" strokeWidth="2" />
      <path d="M330 120h70m-70 13h56m-56 13h36" stroke="#53715c" strokeWidth="3" strokeLinecap="round" />
      <path d="M319 125a8 8 0 0 1-11 7l-4 1 1-4a8 8 0 1 1 14-4Z" fill="#388351" />
      <path d="M309 121c0 4 2 6 6 7" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" />

      {/* One tap confirms the action. */}
      <circle cx="485" cy="181" r="41" fill="#28202d" />
      <circle cx="480" cy="175" r="41" fill="#ffce00" stroke="#28202d" strokeWidth="2" />
      <path d="m461 175 13 13 25-27" fill="none" stroke="#28202d" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M497 195 499 230 507 222 514 237 521 234 514 219 526 218Z" fill="#fff" stroke="#28202d" strokeWidth="2" strokeLinejoin="round" />
      <path d="m521 144 8-8m4 18 11-3m-35-14 3-10" fill="none" stroke="#946613" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setLoading(false);
      if (error.message.toLowerCase().includes("email logins are disabled")) {
        setError(
          "Email logins are disabled in Supabase. Enable them: Dashboard → Authentication → Providers → Email → Enable."
        );
      } else {
        setError(error.message);
      }
      return;
    }
    // A fresh login always starts at the admin batch + module pop-out, even
    // if this tab still remembers a batch from an earlier session.
    clearAdminBatchSelection();
    window.location.href = "/";
  }

  return (
    <main className="login-page">
      {/* ── Left: product story ── */}
      <section className="login-product" aria-labelledby="login-product-title">
        <div className="login-logo" role="img" aria-label="Apply">
          apply
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 20 20 4M7 4h13v13" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <p className="login-kicker">AI-powered application platform</p>
        <h1 id="login-product-title">Put your learning into practice.</h1>
        <LoginStory />
      </section>

      {/* ── Right: sign-in panel ── */}
      <section className="login-panel" aria-labelledby="login-panel-title">
        <div className="login-panel-inner">
          <h2 id="login-panel-title">Welcome</h2>
          <p className="login-hint">Sign in to your Apply account.</p>

          <form className="login-form" onSubmit={handleSubmit}>
            <div>
              <label htmlFor="email">Work email</label>
              <input
                id="email"
                name="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="username"
                autoFocus
                className="login-input"
                placeholder="you@company.com"
                suppressHydrationWarning
              />
            </div>

            <div>
              <label htmlFor="password">Password</label>
              <div className="login-password-field">
                <input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="login-input"
                  placeholder="Enter your password"
                  suppressHydrationWarning
                />
                <button
                  type="button"
                  className="login-reveal"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-controls="password"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  title={showPassword ? "Hide password" : "Show password"}
                  suppressHydrationWarning
                >
                  {showPassword ? <EyeOff size={18} strokeWidth={1.7} /> : <Eye size={18} strokeWidth={1.7} />}
                </button>
              </div>
            </div>

            <p className="login-help">Need help? Email <a href="mailto:team@nudgeable.ai">team@nudgeable.ai</a></p>

            {error && <p className="login-error" role="alert">{error}</p>}

            <button type="submit" className="login-submit" disabled={loading} aria-busy={loading} suppressHydrationWarning>
              {loading ? "Signing in…" : "Sign in"}
              {loading
                ? <Loader2 size={18} className="animate-spin" aria-hidden="true" />
                : <ArrowRight size={18} strokeWidth={1.7} aria-hidden="true" />}
            </button>
          </form>

          <InstallAppButton />
        </div>

        <p className="login-credit">
          Powered by
          <svg viewBox="106 98 704 149" role="img" aria-label="Nudgeable">
            <image width="905" height="353" href="/NudgeableBlack.png" />
          </svg>
        </p>
      </section>
    </main>
  );
}
