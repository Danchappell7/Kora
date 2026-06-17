import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AdminApp } from "./admin/AdminApp";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { initMonitoring } from "./lib/monitoring";
import "./styles/kanbo.css";

initMonitoring();

// Hidden internal route: /admin loads the standalone admin app, never the
// consumer product. Everything else loads Kanbo as normal.
const isAdminRoute = window.location.pathname.replace(/\/+$/, "") === "/admin";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <AuthProvider>
          {isAdminRoute ? <AdminApp /> : <App />}
        </AuthProvider>
      </ToastProvider>
    </ErrorBoundary>
  </StrictMode>,
);
