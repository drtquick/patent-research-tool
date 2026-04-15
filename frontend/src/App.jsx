import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthContext";
import Navbar from "./Navbar";
import Login from "./pages/Login";
import Search from "./pages/Search";
import Portfolio from "./pages/Portfolio";
import Alerts from "./pages/Alerts";
import Analytics from "./pages/Analytics";
import Settings from "./pages/Settings";

function AppRoutes() {
  const { user } = useAuth();

  if (user === undefined) {
    return (
      <div style={{ display: "flex", justifyContent: "center",
        alignItems: "center", height: "100vh", color: "#666" }}>
        Loading…
      </div>
    );
  }

  if (!user) return <Login />;

  return (
    <BrowserRouter>
      <Navbar />
      <Routes>
        <Route path="/"          element={<Navigate to="/portfolio" replace />} />
        <Route path="/search"    element={<Search />} />
        <Route path="/portfolio" element={<Portfolio />} />
        <Route path="/alerts"    element={<Alerts />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/settings"  element={<Settings />} />
        <Route path="*"          element={<Navigate to="/portfolio" replace />} />
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
