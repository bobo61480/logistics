import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type FolderHelpers = {
  getOrCreateShipmentDocsFolderV2_: (
    direction: string,
    customerName: string,
    records: Record<string, unknown>[],
    context: Record<string, unknown>,
    meta: Record<string, unknown>,
  ) => FakeFolder;
  sanitizeDriveFolderNameV2_: (value: string) => string;
  findExistingInboundDocsFolderV2_: (records: Record<string, unknown>[]) => FakeFolder | null;
  shipmentArchiveFolderPathV2_: (direction: string, customerName: string, folder: FakeFolder) => string;
  archiveEmailAttachmentsV2_: (
    attachments: unknown[],
    records: Record<string, unknown>[],
    direction: string,
    customerName: string,
    context: Record<string, unknown>,
    meta: Record<string, unknown>,
  ) => string;
};

class FakeFolder {
  id: string;
  name: string;
  children: FakeFolder[] = [];
  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }
  getName() {
    return this.name;
  }
  getFoldersByName(name: string) {
    const matches = this.children.filter((c) => c.name === name);
    let i = 0;
    return { hasNext: () => i < matches.length, next: () => matches[i++] };
  }
  createFolder(name: string) {
    const folder = new FakeFolder(`${this.id}/${name}`, name);
    this.children.push(folder);
    return folder;
  }
  getUrl() {
    return `https://drive.google.com/drive/folders/${this.id}`;
  }
  getFilesByName() {
    return { hasNext: () => false, next: () => null };
  }
}

function pathFrom(root: FakeFolder, folder: FakeFolder): string[] {
  // Names are unique enough in these fixtures to reconstruct the path by
  // walking the tree once from root.
  function walk(node: FakeFolder, trail: string[]): string[] | null {
    if (node === folder) return trail;
    for (const child of node.children) {
      const found = walk(child, trail.concat(child.name));
      if (found) return found;
    }
    return null;
  }
  return walk(root, []) || [];
}

function loadFolderHelpers(byId: Record<string, FakeFolder> = {}, importsRows?: unknown[][]) {
  const pipeline = readFileSync("google-apps-script/GmailPipelineV2.gs", "utf8");
  const importsSheet = importsRows && {
    getDataRange: () => ({ getDisplayValues: () => importsRows }),
    getRange: (row: number, col: number) => ({
      getRichTextValue: () => (col === 2 ? { getLinkUrl: () => importsRows[row - 1][1] } : null),
    }),
  };
  const context = vm.createContext({
    console,
    Logger: { log: () => {} },
    writeLog_: () => {},
    GMAIL_PIPELINE: { masterId: "test-master", importShipmentsFolderId: "root-id" },
    Utilities: {
      formatDate: (_d: unknown, _z: string, _p: string) => "20260101",
    },
    SpreadsheetApp: {
      openById: () => ({ getSheetByName: (name: string) => (name === "IMPORTS" ? importsSheet || null : null) }),
    },
    DriveApp: {
      getFolderById: (id: string) => {
        if (!byId[id]) throw new Error("Unknown folder id: " + id);
        return byId[id];
      },
    },
  });
  vm.runInContext(
    `${pipeline}\n;globalThis.__folders = { getOrCreateShipmentDocsFolderV2_, sanitizeDriveFolderNameV2_, findExistingInboundDocsFolderV2_, shipmentArchiveFolderPathV2_, archiveEmailAttachmentsV2_ };`,
    context,
  );
  return context.__folders as FolderHelpers;
}

describe("getOrCreateShipmentDocsFolderV2_", () => {
  it("nests Root -> Outbound -> <customer> -> <shipment-id> for an outbound record", () => {
    const root = new FakeFolder("root-id", "ROOT");
    const helpers = loadFolderHelpers({ "root-id": root });
    const meta = { subject: "Shipment update", date: new Date("2026-01-01") };
    const folder = helpers.getOrCreateShipmentDocsFolderV2_(
      "outbound",
      "MEGA MART",
      [{ pro: "PRO123" }],
      {},
      meta,
    );
    expect(pathFrom(root, folder)).toEqual(["Outbound", "MEGA MART", "PRO123"]);
  });

  it("nests Root -> Inbound -> <bucket> -> <shipment-id> for an inbound record", () => {
    const root = new FakeFolder("root-id", "ROOT");
    const helpers = loadFolderHelpers({ "root-id": root });
    const meta = { subject: "Arrival notice", date: new Date("2026-01-01") };
    const folder = helpers.getOrCreateShipmentDocsFolderV2_(
      "inbound",
      "",
      [{ container: "ABCD1234567" }],
      {},
      meta,
    );
    expect(pathFrom(root, folder)).toEqual(["Inbound", "UNSORTED", "ABCD1234567"]);
  });

  it("uses the literal IHERB bucket, not UNSORTED, for an IHERB-routed record", () => {
    const root = new FakeFolder("root-id", "ROOT");
    const helpers = loadFolderHelpers({ "root-id": root });
    const meta = { subject: "IHERB shipment", date: new Date("2026-01-01") };
    const folder = helpers.getOrCreateShipmentDocsFolderV2_("outbound", "IHERB", [{ invoice: "4500999999" }], {}, meta);
    expect(pathFrom(root, folder)).toEqual(["Outbound", "IHERB", "4500999999"]);
  });

  it("reuses the same folder on a second call for the same identity instead of creating a duplicate", () => {
    const root = new FakeFolder("root-id", "ROOT");
    const helpers = loadFolderHelpers({ "root-id": root });
    const meta = { subject: "Shipment update", date: new Date("2026-01-01") };
    const first = helpers.getOrCreateShipmentDocsFolderV2_("outbound", "MEGA MART", [{ pro: "PRO123" }], {}, meta);
    const second = helpers.getOrCreateShipmentDocsFolderV2_("outbound", "MEGA MART", [{ pro: "PRO123" }], {}, meta);
    expect(second).toBe(first);
  });

  it("sanitizes illegal Drive folder characters out of the customer bucket name", () => {
    const helpers = loadFolderHelpers();
    expect(helpers.sanitizeDriveFolderNameV2_('A/B:C*D?E"F<G>H|I')).toBe("A B C D E F G H I");
  });

  // Regression for a Codex review finding: a shipment's first email often
  // carries only an invoice/PO; a later email for the same shipment adds a
  // carrier-assigned PRO/BOL. Preferring invoice keeps both emails naming
  // the SAME folder instead of splitting the shipment's documents across
  // two the moment a PRO/BOL becomes known.
  it("prefers invoice over pro for folder naming, so a later PRO/BOL doesn't split an existing shipment's documents", () => {
    const root = new FakeFolder("root-id", "ROOT");
    const helpers = loadFolderHelpers({ "root-id": root });
    const meta = { subject: "Shipment update", date: new Date("2026-01-01") };
    const first = helpers.getOrCreateShipmentDocsFolderV2_("outbound", "MEGA MART", [{ invoice: "INV001" }], {}, meta);
    const second = helpers.getOrCreateShipmentDocsFolderV2_(
      "outbound",
      "MEGA MART",
      [{ invoice: "INV001", pro: "PRO999" }],
      {},
      meta,
    );
    expect(second).toBe(first);
  });
});

describe("findExistingInboundDocsFolderV2_", () => {
  it("still resolves an existing folder by its stored Drive link, unaffected by the new nested-path scheme for new folders", () => {
    const existingFolder = new FakeFolder("existing-folder-id", "SHIP123");
    const importsRows: unknown[][] = [
      [],
      [],
      ["SHIP123", "https://drive.google.com/drive/folders/existing-folder-id", "", "", "", "", "", "ABCD1234567"],
    ];
    const helpers = loadFolderHelpers({ "existing-folder-id": existingFolder }, importsRows);
    const found = helpers.findExistingInboundDocsFolderV2_([{ container: "ABCD1234567" }]);
    expect(found).toBe(existingFolder);
  });
});

describe("shipmentArchiveFolderPathV2_", () => {
  // Regression for a Codex review finding: the displayed path must reflect
  // the REAL nesting (no year directory, correct direction), not a stale
  // legacy flat path — even though the Drive link itself always pointed to
  // the right folder.
  it("reflects the real direction/bucket/leaf nesting, not the legacy flat path", () => {
    const helpers = loadFolderHelpers();
    const leaf = new FakeFolder("leaf-id", "SHIP123");
    expect(helpers.shipmentArchiveFolderPathV2_("outbound", "MEGA MART", leaf)).toBe("Outbound / MEGA MART / SHIP123");
    expect(helpers.shipmentArchiveFolderPathV2_("inbound", "", leaf)).toBe("Inbound / UNSORTED / SHIP123");
  });
});

describe("archiveEmailAttachmentsV2_", () => {
  // Regression for a Codex review finding: a reused legacy folder (found
  // via a stored Drive link on an older IMPORTS row created before the
  // nested-path scheme existed) can live anywhere in Drive — synthesizing
  // the nested Root -> Inbound/Outbound -> bucket -> shipment-id path for
  // it would show a location that doesn't actually exist. Only a freshly
  // created folder should get that synthesized path.
  it("does not synthesize a nested path for a reused legacy folder", () => {
    const existingFolder = new FakeFolder("existing-folder-id", "SHIP123");
    const importsRows: unknown[][] = [
      [],
      [],
      ["SHIP123", "https://drive.google.com/drive/folders/existing-folder-id", "", "", "", "", "", "ABCD1234567"],
    ];
    const helpers = loadFolderHelpers({ "existing-folder-id": existingFolder }, importsRows);
    const meta: Record<string, unknown> = { subject: "Update", date: new Date("2026-01-01") };
    const url = helpers.archiveEmailAttachmentsV2_([], [{ container: "ABCD1234567" }], "inbound", "", {}, meta);
    expect(url).toBe(existingFolder.getUrl());
    expect(meta.archiveFolderPath).toBe("");
  });

  it("still synthesizes the nested path for a freshly created folder", () => {
    const root = new FakeFolder("root-id", "ROOT");
    const helpers = loadFolderHelpers({ "root-id": root });
    const meta: Record<string, unknown> = { subject: "Update", date: new Date("2026-01-01") };
    helpers.archiveEmailAttachmentsV2_([], [{ invoice: "INV001" }], "outbound", "MEGA MART", {}, meta);
    expect(meta.archiveFolderPath).toBe("Outbound / MEGA MART / INV001");
  });
});
