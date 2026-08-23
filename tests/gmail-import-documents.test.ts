import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type GmailDocumentHelpers = {
  folderIdFromDriveUrlV2_: (url: unknown) => string;
  createAttachmentIfMissingV2_: (folder: unknown, attachment: unknown) => void;
};

function loadHelpers(): GmailDocumentHelpers {
  const source = ["google-apps-script/GmailPipeline.gs", "google-apps-script/GmailPipelineV2.gs"]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  const context = vm.createContext({ Date, console });
  vm.runInContext(
    `${source}\n;globalThis.__gmailDocs = {folderIdFromDriveUrlV2_,createAttachmentIfMissingV2_};`,
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
});
