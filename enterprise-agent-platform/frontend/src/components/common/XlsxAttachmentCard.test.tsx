// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCALE_STORAGE_KEY } from "../../i18n";
import { resetApiSession } from "../../lib/api";
import { TestUiProviders } from "../../test/TestUiProviders";
import type { Attachment } from "../../types";
import { MessageAttachments } from "./MessageAttachments";

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

afterEach(() => {
  cleanup();
  resetApiSession();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("XlsxAttachmentCard", () => {
  it("loads a table preview and keeps expand and download actions in the header", async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    const fetchMock = vi.fn(async () => response(200, {
      attachment_id: 9,
      filename: "report.xlsx",
      sheet_count: 2,
      truncated: false,
      sheets: [
        {
          name: "Summary",
          rows: [["Metric", "Value"], ["Revenue", "42"]],
          columns: 2,
          truncated: false,
        },
        {
          name: "Notes",
          rows: [["Reviewed"]],
          columns: 1,
          truncated: false,
        },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const attachment: Attachment = {
      id: 9,
      filename: "report.xlsx",
      mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size_bytes: 4096,
      preview_url: "/api/attachments/9/xlsx-preview",
      download_url: "/api/attachments/9?download=1",
    };
    const user = userEvent.setup();

    render(
      <TestUiProviders>
        <MessageAttachments attachments={[attachment]} />
      </TestUiProviders>,
    );

    await waitFor(() => expect(screen.getByText("Revenue")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/attachments/9/xlsx-preview",
      expect.objectContaining({ credentials: "include" }),
    );
    const expand = screen.getByRole("button", { name: "Expand spreadsheet preview" });
    const download = screen.getByRole("link", { name: "Download workbook" });
    expect(expand).toBeEnabled();
    expect(download).toHaveAttribute("href", "/api/attachments/9?download=1");

    await user.click(expand);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Summary" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Notes" })).toBeInTheDocument();
  });

  it("keeps the original download available when preview parsing fails", async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    vi.stubGlobal("fetch", vi.fn(async () => response(422, {
      error: "XLSX preview is unavailable",
    })));

    render(
      <TestUiProviders>
        <MessageAttachments attachments={[{
          id: 10,
          filename: "broken.xlsx",
          preview_url: "/api/attachments/10/xlsx-preview",
          download_url: "/api/attachments/10?download=1",
        }]} />
      </TestUiProviders>,
    );

    expect(await screen.findByText(/Preview unavailable/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download workbook" })).toHaveAttribute(
      "href",
      "/api/attachments/10?download=1",
    );
    expect(screen.getByRole("button", { name: "Expand spreadsheet preview" })).toBeDisabled();
  });
});
