import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type GmailDocumentHelpers = {
  folderIdFromDriveUrlV2_: (url: unknown) => string;
  createAttachmentIfMissingV2_: (folder: unknown, attachment: unknown) => void;
  emailNoteV2_: (record: unknown) => string;
};

function loadHelpers(): GmailDocumentHelpers {
  const source = ["google-apps-script/GmailPipeline.gs", "google-apps-script/GmailPipelineV2.gs"]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  const context = vm.createContext({ Date, console });
  vm.runInContext(
    `${source}\n;globalThis.__gmailDocs = {folderIdFromDriveUrlV2_,createAttachmentIfMissingV2_,emailNoteV2_};`,
    context,
  );
  return context.__gmailDocs as GmailDocumentHelpers;
}

const helpers = loadHelpers();

describe("Gmail inbound document archiving", () => {
  it("extracts the canonical folder id from an IMPORTS DOCS link", () => {
    expect(
      helpers.folderIdFromDriveUrlV2_(
        "https://drive.google.com/drive/folders/1tAkVlLJAH1-q4ZCOFO0lAJnEF9-SX376?usp=sharing",
      ),
    ).toBe("1tAkVlLJAH1-q4ZCOFO0lAJnEF9-SX376");
    expect(helpers.folderIdFromDriveUrlV2_("https://drive.google.com/file/d/not-a-folder/view")).toBe("");
  });

  it("does not upload a duplicate attachment with the same name and size", () => {
    const createFile = vi.fn();
    const folder = {
      getFilesByName: () => {
        let read = false;
        return {
          hasNext: () => !read,
          next: () => {
            read = true;
            return { getSize: () => 222668 };
          },
        };
      },
      createFile,
    };
    const attachment = {
      getName: () => "ES 30차.zip",
      getSize: () => 222668,
      getBytes: () => new Array(222668),
      copyBlob: vi.fn(),
    };

    helpers.createAttachmentIfMissingV2_(folder, attachment);
    expect(createFile).not.toHaveBeenCalled();
    expect(attachment.copyBlob).not.toHaveBeenCalled();
  });

  it("builds a note carrying the Gmail permalink auto-tag the dashboard's commit-tracking parses", () => {
    // Regression guard: emailNoteV2_ was a no-op stub that returned "" for
    // every record, silently discarding the source-email note on every
    // inbound and outbound row and breaking the dashboard's [auto: ...]
    // committed-event tracking.
    const note = helpers.emailNoteV2_({
      _emailSubject: "STY-2226-BOL.pdf",
      _sourceEmail: "https://mail.google.com/mail/u/0/#all/1a016ec85cbfdb21",
    });
    expect(note).toContain("STY-2226-BOL.pdf");
    expect(note).toContain("[auto: https://mail.google.com/mail/u/0/#all/1a016ec85cbfdb21]");
  });

  it("archives attachments for both inbound and outbound emails (not gated to inbound only)", () => {
    const source = readFileSync("google-apps-script/GmailPipelineV2.gs", "utf8");
    expect(source).not.toContain('context.kind !== "outbound"');
    expect(source).toContain("archiveEmailAttachmentsV2_(documentAttachments, records, context, meta)");
    expect(source).toContain("function findExistingOutboundDocsFolderV2_(");
    expect(source).toContain("function setOutboundDocsLinkV2_(");
  });
});
