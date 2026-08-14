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

describe("AttachmentPreviewCard", () => {
  it("loads a table preview and keeps expand and download actions in the header", async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    const fetchMock = vi.fn(async () => response(200, {
      attachment_id: 9,
      filename: "report.xlsx",
      kind: "xlsx",
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
      preview_url: "/api/attachments/9/preview",
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
      "/api/attachments/9/preview",
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

  it("renders document text previews for Word, slides, and PDF", async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/11/preview")) {
        return response(200, {
          attachment_id: 11,
          filename: "review.docx",
          kind: "docx",
          truncated: false,
          section_count: 1,
          sections: [{ blocks: ["Quarterly review", "Revenue held at 42."], truncated: false }],
        });
      }
      if (String(url).includes("/12/preview")) {
        return response(200, {
          attachment_id: 12,
          filename: "deck.pptx",
          kind: "pptx",
          truncated: false,
          section_count: 2,
          sections: [
            { index: 1, blocks: ["Goals"], truncated: false },
            { index: 2, blocks: ["Next steps"], truncated: false },
          ],
        });
      }
      return response(200, {
        attachment_id: 13,
        filename: "brief.pdf",
        kind: "pdf",
        truncated: true,
        section_count: 4,
        sections: [{ index: 1, blocks: ["Executive summary"], truncated: false }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <TestUiProviders>
        <MessageAttachments attachments={[
          {
            id: 11,
            filename: "review.docx",
            preview_url: "/api/attachments/11/preview",
            download_url: "/api/attachments/11?download=1",
          },
          {
            id: 12,
            filename: "deck.pptx",
            preview_url: "/api/attachments/12/preview",
            download_url: "/api/attachments/12?download=1",
          },
          {
            id: 13,
            filename: "brief.pdf",
            preview_url: "/api/attachments/13/preview",
            download_url: "/api/attachments/13?download=1",
          },
        ]} />
      </TestUiProviders>,
    );

    expect(await screen.findByText("Quarterly review")).toBeInTheDocument();
    expect(screen.getByText(/Word document/)).toBeInTheDocument();
    expect(screen.getByText("Goals")).toBeInTheDocument();
    expect(screen.getAllByText("Slide 1").length).toBeGreaterThan(0);
    expect(screen.getByText("Executive summary")).toBeInTheDocument();
    expect(screen.getByText("Page 1")).toBeInTheDocument();
    expect(screen.getAllByText(/limited preview/i).length).toBeGreaterThan(0);

    await user.click(screen.getAllByRole("button", { name: "Expand preview" })[1]);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Slide 1" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Slide 2" })).toBeInTheDocument();
  });

  it("keeps the original download available when preview parsing fails", async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    vi.stubGlobal("fetch", vi.fn(async () => response(422, {
      error: "Document preview is unavailable",
    })));

    render(
      <TestUiProviders>
        <MessageAttachments attachments={[{
          id: 10,
          filename: "broken.xlsx",
          preview_url: "/api/attachments/10/preview",
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
