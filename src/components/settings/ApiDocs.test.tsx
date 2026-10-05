/* The API reference: every endpoint from the OpenAPI document, grouped,
   with parameters, examples and a copyable curl using the base URL. */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ApiDocs, curlFor, groupOperations } from "./ApiDocs";
import { buildOpenApi } from "../../../supabase/functions/_shared/api/openapi.ts";
import { coreRoutes } from "../../../supabase/functions/_shared/api/routes.ts";

const BASE = "https://htnchiljplrnjkwimgla.supabase.co/functions/v1/api/v1";

describe("ApiDocs", () => {
  it("lists every endpoint, grouped by tag", () => {
    const { container } = render(<ApiDocs baseUrl={BASE + "/"} keyHint="kanbo_sk_Ab3x" />);
    expect(screen.getByRole("heading", { level: 2, name: "API reference" })).toBeInTheDocument();
    for (const g of ["Account", "Tasks", "Projects", "Sections", "Comments"]) expect(screen.getByRole("heading", { level: 3, name: g })).toBeInTheDocument();
    const paths = Array.from(container.querySelectorAll(".kdoc-op")).map((d) => `${d.querySelector(".kpill")?.textContent} ${d.querySelector(".kdoc-path")?.textContent}`);
    for (const r of coreRoutes) expect(paths).toContain(`${r.method} ${r.path.replace(/:([a-z]+)/g, "{$1}")}`);
    expect(screen.getAllByText(BASE).length).toBeGreaterThan(0);
    expect(screen.getByText(/export KANBO_API_KEY="kanbo_sk_Ab3x…"/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try it/i })).toBeNull();
  });

  it("an endpoint shows its parameters, examples, errors and a curl", () => {
    const { container } = render(<ApiDocs baseUrl={BASE} />);
    const op = container.querySelector("#op-createTask") as HTMLDetailsElement;
    fireEvent.click(op.querySelector("summary")!);
    const body = within(op);
    expect(body.getByRole("table")).toHaveTextContent("Idempotency-Key");
    expect(body.getByLabelText("Create a task: request body")).toHaveTextContent('"title": "Write the launch blog post"');
    expect(body.getByLabelText("Create a task: example response")).toHaveTextContent('"object": "task"');
    expect(body.getByText(/422/)).toBeInTheDocument();
    const curl = body.getByLabelText("Create a task: curl example").textContent!;
    expect(curl).toContain(`curl -X POST "${BASE}/tasks"`);
    expect(curl).toContain('-H "Authorization: Bearer $KANBO_API_KEY"');
    expect(curl).toContain('-H "Idempotency-Key: $(uuidgen)"');
    expect(body.getByRole("button", { name: "Copy Create a task: curl example" })).toBeInTheDocument();
  });

  it("filters endpoints", () => {
    render(<ApiDocs baseUrl={BASE} />);
    const box = screen.getByLabelText("Filter endpoints");
    fireEvent.change(box, { target: { value: "/comments" } });
    expect(screen.getByRole("status")).toHaveTextContent(/^2 endpoints$/);
    expect(screen.queryByRole("heading", { level: 3, name: "Projects" })).toBeNull();
    fireEvent.change(box, { target: { value: "nothing like this" } });
    expect(screen.getByText(/No endpoints match/)).toBeInTheDocument();
  });

  it("has a Back control only when it opens on its own", () => {
    const onClose = vi.fn();
    const { rerender } = render(<ApiDocs baseUrl={BASE} />);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    rerender(<ApiDocs baseUrl={BASE} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("never puts a full key in the examples", () => {
    render(<ApiDocs baseUrl={BASE} keyHint={"kanbo_sk_" + "A".repeat(43)} />);
    expect(document.body.textContent).not.toContain("A".repeat(43));
    expect(screen.getByText(/export KANBO_API_KEY="kanbo_sk_…"/)).toBeInTheDocument();
  });
});

describe("helpers", () => {
  const doc = buildOpenApi(BASE);
  it("curl: example path ids, required query parameters, quoted bodies", () => {
    const sections = groupOperations(doc).flatMap((g) => g.ops).find((d) => d.op.operationId === "listSections")!;
    expect(curlFor(BASE, sections)).toBe(`curl "${BASE}/sections?project=2b7e9c1d-3f4a-4b5c-8d6e-7f8091a2b3c4" \\\n  -H "Authorization: Bearer $KANBO_API_KEY"`);
    const comment = groupOperations(doc).flatMap((g) => g.ops).find((d) => d.op.operationId === "createComment")!;
    const c = curlFor(BASE, comment);
    expect(c).toContain(`/tasks/5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9/comments"`);
    const spec = groupOperations(doc).flatMap((g) => g.ops).find((d) => d.op.operationId === "getOpenApi")!;
    expect(curlFor(BASE, spec)).not.toContain("Authorization");
    const quoted = curlFor(BASE, { ...comment, op: { ...comment.op, requestBody: { content: { "application/json": { example: { body: "it's fine" } } } } } });
    expect(quoted).toContain(`-d '{"body":"it'\\''s fine"}'`);
  });
  it("groups in the document's tag order and filters on every word", () => {
    expect(groupOperations(doc).map((g) => g.tag).slice(0, 5)).toEqual(["Account", "Tasks", "Projects", "Sections", "Comments"]);
    // every word must appear (in the method, path, summary or description)
    expect(groupOperations(doc, "patch tasks").flatMap((g) => g.ops).map((d) => d.op.operationId)).toEqual(["updateTask", "deleteTask"]);
    expect(groupOperations(doc, "PATCH projects").flatMap((g) => g.ops).map((d) => d.op.operationId)).toEqual(["updateProject"]);
  });
});
