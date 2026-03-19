import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthContext";
import Navbar from "./Navbar";
import Login from "./pages/Login";
import Search from "./pages/Search";
import Portfolio from "./pages/Portfolio";
import Alerts from "./pages/Alerts";

function AppRoutes() {
  const { user } = useAuth();

  // Still loading auth state
  if (user === undefined) {
    return (
      <div style={{ display: "flex", justifyContent: "center",
        alignItems: "center", height: "100vh", color: "#666" }}>
        Loading…
      </div>
    );
  }

  // Not logged in → show login
  if (!user) return <Login />;

  // Logged in → show app
  return (
    <BrowserRouter>
      <Navbar />
      <Routes>
        <Route path="/" element={<Navigate to="/search" replace />} />
        <Route path="/search" element={<Search />} />
        <Route path="/portfolio" element={<Portfolio />} />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="*" element={<Navigate to="/search" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
