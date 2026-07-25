// End-to-end smoke test of the whole frontend against the dev mock backend
// (src/devMock.ts): scan → streaming summary → treemap → drill → breadcrumbs.
import { afterEach, describe, expect, test } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import App from "../App";

// Vitest globals are off, so testing-library can't auto-register cleanup;
// without this every test keeps the previous App mounted.
afterEach(cleanup);

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

  test("reclaimable tab: headline, groups, explicit selection, script modal", async () => {
    render(<App />);
    const scanBtn = await screen.findByRole("button", { name: "Scan" });
    await waitFor(() =>
      expect((scanBtn as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(scanBtn);
    await waitFor(() => screen.getByText("Scan time"), { timeout: 15000 });

    // The headline metric appears in the summary bar; clicking opens the tab.
    const cell = await screen.findByTitle(
      "What could plausibly be freed (before duplicate detection)"
    );
    expect(cell.textContent).toContain("Reclaimable");
    expect(cell.textContent).toContain("%");
    fireEvent.click(cell);
    await screen.findByText(/plausibly reclaimable/);

    // Groups arrive sorted by size with visible confidence classes.
    await screen.findByText("App caches");
    expect(screen.getByText("Build artifacts")).toBeTruthy();
    expect(screen.getByText("Used installers")).toBeTruthy();
    expect(screen.getAllByText(/regenerates — safe/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/gone forever/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/hint — review first/i).length).toBeGreaterThan(0);
    // Findings explain themselves.
    expect(screen.getByText(/npm \/ yarn \/ pnpm install/)).toBeTruthy();

    // Selection starts empty; the script action is locked until it isn't.
    expect(screen.getByText(/Nothing is ever pre-selected/)).toBeTruthy();
    const scriptBtn = screen.getByRole("button", {
      name: "Deletion script…",
    }) as HTMLButtonElement;
    expect(scriptBtn.disabled).toBe(true);

    // Select-all exists ONLY on regenerable groups — never on gone-forever.
    const selAlls = screen.getAllByText("Select all in this group");
    expect(selAlls.length).toBe(2); // App caches + Build artifacts
    const trashGroup = screen.getByText("Trash").closest(".reclaim-group")!;
    expect(trashGroup.textContent).not.toContain("Select all in this group");

    // Explicit per-row selection updates the running readout.
    fireEvent.click(screen.getByLabelText("Select node_modules"));
    fireEvent.click(screen.getByLabelText("Select target"));
    await waitFor(() => {
      const info = document.querySelector(".reclaim-footer-info");
      expect(info?.textContent).toMatch(/2\s*selected — would\s*free/);
    });

    // The script modal: Trash is the default, dry-run is stated, and the
    // permanent variant is a visible, explicit alternative.
    expect(scriptBtn.disabled).toBe(false);
    fireEvent.click(scriptBtn);
    await screen.findByText("Generate deletion script");
    expect(screen.getByText("Move to Trash")).toBeTruthy();
    expect(screen.getByText("Delete permanently")).toBeTruthy();
    expect(screen.getByText(/preview by default/)).toBeTruthy();
    const copyBtn = screen.getByRole("button", {
      name: /Copy move-to-Trash script/,
    });
    fireEvent.click(copyBtn);
    await screen.findByText(/Deletion script copied/);
  }, 30000);

  test("duplicate pass: explicit start, progress, kept copy excluded", async () => {
    render(<App />);
    const scanBtn = await screen.findByRole("button", { name: "Scan" });
    await waitFor(() =>
      expect((scanBtn as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(scanBtn);
    await waitFor(() => screen.getByText("Scan time"), { timeout: 15000 });

    fireEvent.click(screen.getByRole("tab", { name: "Reclaimable" }));
    // Duplicates are a separate, explicitly-triggered pass.
    const findBtn = await screen.findByRole("button", {
      name: "Find duplicates",
    });
    expect(screen.getByText(/reads file contents/)).toBeTruthy();
    fireEvent.click(findBtn);

    // It reports its own progress, then verified groups.
    await waitFor(
      () => {
        const name = document.querySelector(".reclaim-dup-name");
        expect(name?.textContent).toBe("export-final.jpg");
      },
      { timeout: 10000 }
    );
    // The kept copy is visibly excluded from the number and unselectable.
    expect(screen.getByText("kept — not counted")).toBeTruthy();
    expect(
      screen.queryByLabelText("Select copy /Users/you/Pictures/export-final.jpg")
    ).toBeNull();
    expect(
      screen.getByLabelText("Select copy /Users/you/Documents/export-final.jpg")
    ).toBeTruthy();
    // Keep-one accounting is spelled out.
    expect(screen.getByText(/one copy stays/)).toBeTruthy();
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
