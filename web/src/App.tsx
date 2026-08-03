import { useEffect, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabaseClient";
import { ApiError, fetchTonight, type TonightResponse } from "./api";

// One screen, two states: signed out (login form) and signed in (Tonight request +
// result). This slice is a wire, not a screen — no router, no component library, no
// styling beyond browser defaults.

function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSignIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) setError(signInError.message);
    setBusy(false);
  }

  async function handleSignUp() {
    setBusy(true);
    setError(null);
    const { error: signUpError } = await supabase.auth.signUp({ email, password });
    if (signUpError) setError(signUpError.message);
    setBusy(false);
  }

  return (
    <form onSubmit={handleSignIn}>
      <h1>Matmatch</h1>
      <div>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
      </div>
      <div>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={6}
          />
        </label>
      </div>
      <button type="submit" disabled={busy}>
        Sign in
      </button>
      <button type="button" disabled={busy} onClick={handleSignUp}>
        Sign up
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

type TonightState =
  | { status: "loading" }
  | { status: "loaded"; data: TonightResponse }
  | { status: "error"; code: string; message: string };

function TonightView({ session }: { session: Session }) {
  const [state, setState] = useState<TonightState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    fetchTonight(session.access_token)
      .then((data) => {
        if (!cancelled) setState({ status: "loaded", data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError) {
          setState({ status: "error", code: error.code, message: error.message });
        } else {
          setState({ status: "error", code: "network_error", message: String(error) });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [session.access_token]);

  return (
    <div>
      <p>
        Signed in as {session.user.email}{" "}
        <button type="button" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </p>
      <h2>Tonight</h2>
      {state.status === "loading" && <p>Loading…</p>}
      {state.status === "error" && <pre>{`error: ${state.code}\n${state.message}`}</pre>}
      {state.status === "loaded" && state.data.result === null && (
        <pre>{`no result: ${state.data.reason}`}</pre>
      )}
      {state.status === "loaded" && state.data.result !== null && (
        <pre>{JSON.stringify(state.data.result, null, 2)}</pre>
      )}
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (session === undefined) return <p>Loading…</p>;
  if (session === null) return <LoginForm />;
  return <TonightView session={session} />;
}
