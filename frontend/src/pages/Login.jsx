import { useState } from "react";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
} from "firebase/auth";
import { auth, googleProvider } from "../firebase";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (isSignUp) {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err) {
      setError(err.message.replace("Firebase: ", ""));
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogle() {
    setError("");
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setError(err.message.replace("Firebase: ", ""));
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>⚖️ Patent Research Tool</h1>
        <p style={styles.subtitle}>Patent family status &amp; fee tracker</p>
        <form onSubmit={handleSubmit} style={styles.form}>
          <input style={styles.input} type="email" placeholder="Email"
            value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input style={styles.input} type="password" placeholder="Password"
            value={password} onChange={(e) => setPassword(e.target.value)} required />
          {error && <p style={styles.error}>{error}</p>}
          <button style={styles.btn} type="submit" disabled={loading}>
            {loading ? "…" : isSignUp ? "Create Account" : "Sign In"}
          </button>
        </form>
        <div style={styles.divider}><span>or</span></div>
        <button style={styles.googleBtn} onClick={handleGoogle}>
          <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg"
            alt="Google" style={{ width: 18, marginRight: 8 }} />
          Continue with Google
        </button>
        <p style={styles.toggle}>
          {isSignUp ? "Already have an account? " : "New user? "}
          <button style={styles.link} onClick={() => setIsSignUp(!isSignUp)}>
            {isSignUp ? "Sign in" : "Create account"}
          </button>
        </p>
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: "100vh", display: "flex", alignItems: "center",
    justifyContent: "center", background: "#f0f4f8" },
  card: { background: "#fff", borderRadius: 12, padding: "2.5rem 2rem",
    width: 380, boxShadow: "0 4px 24px rgba(0,0,0,.1)" },
  title: { margin: 0, fontSize: "1.6rem", color: "#1a1a2e", textAlign: "center" },
  subtitle: { textAlign: "center", color: "#666", marginTop: 6, marginBottom: 24 },
  form: { display: "flex", flexDirection: "column", gap: 12 },
  input: { padding: "10px 14px", borderRadius: 8, border: "1px solid #d0d7de",
    fontSize: 15, outline: "none" },
  btn: { padding: "11px", borderRadius: 8, background: "#1a73e8", color: "#fff",
    border: "none", fontSize: 15, cursor: "pointer", fontWeight: 600 },
  error: { color: "#d32f2f", fontSize: 13, margin: 0 },
  divider: { textAlign: "center", margin: "16px 0", color: "#999",
    borderTop: "1px solid #eee", position: "relative", lineHeight: 0 },
  googleBtn: { width: "100%", padding: "10px", borderRadius: 8,
    border: "1px solid #d0d7de", background: "#fff", cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 15, fontWeight: 500, marginTop: 8 },
  toggle: { textAlign: "center", marginTop: 16, color: "#555", fontSize: 14 },
  link: { background: "none", border: "none", color: "#1a73e8",
    cursor: "pointer", fontSize: 14, padding: 0, fontWeight: 600 },
};
