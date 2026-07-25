// End-to-end smoke test of the whole frontend against the dev mock backend
// (src/devMock.ts): scan → streaming summary → treemap → drill → breadcrumbs.
import { describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "../App";

describe("App (against mock backend)", () => {
  test("idle → scan → map renders → drill down and back", async () => {
    render(<App />);

    // Idle state with the pitch.
    await screen.findByText("Where did the space go?");

    // Path is prefilled from home_dir; Scan becomes enabled.
    const scanBtn = await screen.findByRole("button", { name: "Scan" });
    await waitFor(() =>
      expect((scanBtn as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(scanBtn);

    // Scanning phase streams progress.
    await screen.findByText(/Scanning|files/);

    // Mock scan takes ~3s; summary bar appears when done.
    await waitFor(() => screen.getByText("Scan time"), { timeout: 15000 });
    expect(screen.getByText("On disk")).toBeTruthy();

    // Skipped territory is surfaced.
    expect(screen.getByText("Not scanned")).toBeTruthy();

    // The treemap rendered blocks; folder headers include top-level dirs.
    await waitFor(() => {
      expect(document.querySelector(".treemap-svg")).toBeTruthy();
      expect(screen.getAllByText("Movies").length).toBeGreaterThan(0);
    });

    // Drill into Movies via its aria-labelled block.
    const movies = document.querySelector(
      'g[aria-label^="Movies"]'
    ) as SVGGElement;
    expect(movies).toBeTruthy();
    fireEvent.click(movies);

    // Breadcrumbs now show root + Movies, and a back button exists.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Go up one level" })
      ).toBeTruthy();
      expect(screen.getByTitle("/Users/you/Movies")).toBeTruthy();
    });

    // Go back up.
    fireEvent.click(screen.getByRole("button", { name: "Go up one level" }));
    await waitFor(() =>
      expect(screen.queryByTitle("/Users/you/Movies")).toBeNull()
    );

    // Statistics tab is linked and populated.
    fireEvent.click(screen.getByRole("tab", { name: "Statistics" }));
    await screen.findByText("By category");
    await screen.findByText("Largest files");
  }, 30000);

  test("search finds files and context menu offers the three actions", async () => {
    render(<App />);
    const scanBtn = await screen.findByRole("button", { name: "Scan" });
    await waitFor(() =>
      expect((scanBtn as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(scanBtn);
    await waitFor(() => screen.getByText("Scan time"), { timeout: 15000 });

    // Search: type a query, get ranked results.
    const search = screen.getByPlaceholderText(/Search files and folders/);
    fireEvent.focus(search);
    fireEvent.change(search, { target: { value: "movies" } });
    await waitFor(
      () => {
        expect(
          document.querySelectorAll(".search-row").length
        ).toBeGreaterThan(0);
      },
      { timeout: 5000 }
    );

    // Context menu on a search result.
    const row = document.querySelector(".search-row") as HTMLElement;
    fireEvent.contextMenu(row, { clientX: 100, clientY: 100 });
    await screen.findByText("Reveal in Finder");
    await screen.findByText("Copy Path");
    await screen.findByText("Copy Delete Command");
    expect(screen.getByText(/never deletes anything/)).toBeTruthy();

    // Copy Path puts the path on the (mock) clipboard and shows a toast.
    fireEvent.click(screen.getByText("Copy Path"));
    await screen.findByText("Path copied.");
  }, 30000);

  test("skipped panel opens with explanations", async () => {
    render(<App />);
    const scanBtn = await screen.findByRole("button", { name: "Scan" });
    await waitFor(() =>
      expect((scanBtn as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(scanBtn);
    await waitFor(() => screen.getByText("Not scanned"), { timeout: 15000 });

    fireEvent.click(screen.getByTitle("What wasn't scanned, and why"));
    await screen.findByText("Cloud storage");
    await screen.findByText("/Users/you/Library/CloudStorage");
  }, 30000);
});
