import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";

describe("App (demo mode)", () => {
  it("boots and renders the workspace shell", async () => {
    render(
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>,
    );
    // bootstrap is async; wait for the sidebar nav to appear
    await waitFor(() => expect(screen.getByText("Plan my day")).toBeInTheDocument());
    expect(screen.getByText("My tasks")).toBeInTheDocument();
    expect(screen.getByText("Analytics")).toBeInTheDocument();
  });
});
