    // ─── Constants ───────────────────────────────────────────────────────────────

    /** Main logistics tracking spreadsheet (Logistics Dashboard). */
    const SPREADSHEET_ID = "1M-vZ24Yw4ZN7R7b_473cVn8kny8DznTakSsD3VQsCzc";

    /** Warehouse Management System spreadsheet (WMS Operations). */
    const WMS_SPREADSHEET_ID = "14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I";

    const OUTBOUND_STATUS = [
      "", "SCHEDULED", "WORK IN PROGRESS", "PENDING", "SHIPPING",
      "SHIPPED", "DELIVERED", "RECEIVED", "CANCELLED", "COMPLETED",
    ];
    const INBOUND_STATUS = [
      "", "SCHEDULED", "WORK IN PROGRESS", "PENDING", "SHIPPING",
      "SHIPPED", "DELIVERED", "RECEIVED", "CANCELLED", "COMPLETED",
      "N/A", "Customs Clearance", "FDA Review/Hold", "FWS Review/Hold", "Delayed",
    ];

    // Pre-built Sets for O(1) status validation (built once at load time).
    const OUTBOUND_STATUS_SET = new Set(OUTBOUND_STATUS.map(s => s.toUpperCase()));
    const INBOUND_STATUS_SET  = new Set(INBOUND_STATUS.map(s => s.toUpperCase()));

    const ALLOWED_SHEETS = new Set([
      "WH Trucking Request", "B2B/E-COM TRUCKING", "TRANSFERS",
      "ULTA", "IHERB", "IMPORTS", "NATIONAL ORDER PROGRESS",
      "Outbound Shipping Schedule", "TJX/ROSS",
    ]);

    const COMPLETED_STATUSES = new Set([
      "SHIPPED", "DELIVERED", "RECEIVED", "CANCELLED", "COMPLETED",
    ]);

    // Required by transferInboundInventory_
    const INVENTORY_TRANSFER_STATUSES = ["DELIVERED", "RECEIVED", "COMPLETED"];
    const SKW_INBOUND_SHEET = "SKW_Inbound";
    const SKW_STOCK_SHEET   = "SKW_Stock";

    /**
    * Maps logical field names to the header keywords used to detect them in the
    * WMS source sheet.  Keeping this declarative makes it trivial to add columns.
    */
    const WMS_COLUMN_SPECS = {
      shipMethod: ["SHIPPING METHOD", "SHIP METHOD"],
      invoice:    ["INVOICE", "PO#", "PO NUMBER"],
      customer:   ["CUSTOMER", "CLIENT", "ACCOUNT"],
      shipDate:   ["SHIP DATE", "DATE", "PU DATE"],
      pallets:    ["PALLET", "PLT", "QTY", "CARTONS"],
      carrier:    ["CARRIER", "TRUCKING"],
      pro:        ["PRO#", "PRO", "TRACKING", "BOL"],
      note:       ["NOTE", "REMARK", "MEMO", "ISSUE"],
    };

    // ─── Web-app entry point ──────────────────────────────────────────────────────

    function doPost(e) {
      const lock = LockService.getScriptLock();

      // Explicit guard so callers receive a clear "retry" message instead of a
      // generic error when the lock is already held.
      try {
        lock.waitLock(10000);
      } catch (_) {
        return json_({ ok: false, error: "Server busy. Please retry in a moment." });
      }

      try {
        // Normalise body: Apps Script may deliver it in postData.contents or as a
        // query parameter when the request is URL-encoded.
        let rawContents = (e && e.postData && e.postData.contents) || "";
        if (!rawContents && e && e.parameter && e.parameter.postData) {
          rawContents = e.parameter.postData;
        }
        const request = JSON.parse(rawContents || "{}");
        validateRequest_(request);

        const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
        const sheet = spreadsheet.getSheetByName(request.sourceSheet);
        if (!sheet) throw new Error("Source sheet not found.");

        const target = request.kind === "inbound"
          ? findInboundTarget_(sheet, request)
          : findOutboundTarget_(sheet, request);

        const allowed = request.kind === "inbound" ? INBOUND_STATUS_SET : OUTBOUND_STATUS_SET;
        const status  = String(request.status || "").trim();
        if (!allowed.has(status.toUpperCase())) throw new Error("Status is not allowed.");

        // Concurrency note: log when the caller's view of the current status differs
        // from what is actually in the cell (tolerate "" ↔ "SCHEDULED" as equivalent).
        const current        = String(target.getDisplayValue() || "").trim();
        const requestCurrent = String(request.currentStatus || "").trim();
        const normCurrent = current.toUpperCase();
        const normRequest = requestCurrent.toUpperCase();

        // Prevent stale browser state from overwriting a newer workbook value.
        const scheduledFallback = (!normCurrent && normRequest === "SCHEDULED") || (normCurrent === "SCHEDULED" && !normRequest);
        if (requestCurrent && normCurrent !== normRequest && !scheduledFallback) {
          throw new Error("Status changed in Google Sheets. Refresh and try again.");
        }

        // Cache lastColumn before writing so we only call getLastColumn() once.
        const lastCol = Math.max(sheet.getLastColumn(), 1);
        target.setValue(status);

        let inventoryTransfer = null;
        if (request.kind === "inbound" && INVENTORY_TRANSFER_STATUSES.includes(status.toUpperCase())) {
          inventoryTransfer = transferInboundInventory_(spreadsheet, request);
        }

        // Grey out completed rows; reset colouring for active rows.
        const rowIdx    = target.getRow();
        const rowRange  = sheet.getRange(rowIdx, 1, 1, lastCol);
        const isCompleted = COMPLETED_STATUSES.has(status.toUpperCase());
        if (isCompleted) {
          rowRange.setBackground("#E8EAED").setFontColor("#5F6368");
        } else {
          rowRange.setBackground(null).setFontColor(null);
        }

        SpreadsheetApp.flush();
        return json_({ ok: true, sheet: sheet.getName(), row: rowIdx, status, isCompleted, inventoryTransfer });
      } catch (error) {
        return json_({ ok: false, error: String(error.message || error) });
      } finally {
        lock.releaseLock();
      }
    }

    // ─── Request validation ───────────────────────────────────────────────────────

    function validateRequest_(request) {
      if (!["outbound", "inbound"].includes(request.kind)) {
        throw new Error("Invalid relation kind.");
      }
      if (!ALLOWED_SHEETS.has(request.sourceSheet)) {
        throw new Error("Source sheet is not allowed.");
      }
    }

    // ─── Row-finding helpers ──────────────────────────────────────────────────────

    function findInboundTarget_(sheet, request) {
      const row = Number(request.sourceRow);
      if (!Number.isInteger(row) || row < 3 || row > sheet.getLastRow()) {
        throw new Error("Invalid IMPORTS source row.");
      }
      const headers = sheet.getRange(1, 1, 3, sheet.getLastColumn()).getDisplayValues();
      const header  = findHeader_(headers, ["WEBSITE STATUS", "STATUS", "INBOUND STATUS", "SHIPMENT STATUS"]);
      if (!header) throw new Error("Inbound status column not found.");
      return sheet.getRange(row, header.column);
    }

    function findOutboundTarget_(sheet, request) {
      const values = sheet.getDataRange().getDisplayValues();
      // Limit header scan to the first 4 rows without allocating a slice.
      const header = findHeader_(values, ["WEBSITE STATUS", "STATUS", "WORK PROGRESS", "INBOUND STATUS", "SHIPMENT STATUS"], 4);
      if (!header) throw new Error("Status column not found.");

      const map       = headerMap_(values[header.row - 1]);
      const sourceRow = Number(request.sourceRow);
      if (Number.isInteger(sourceRow) && sourceRow > header.row && sourceRow <= values.length) {
        return sheet.getRange(sourceRow, header.column);
      }

      // Fall back to fuzzy matching: score each data row on field matches.
      const candidates = [];
      for (let r = header.row; r < values.length; r++) {
        const row = values[r];
        let score = 0;
        score += exact_(row, map, ["PRO#", "BOL", "BOL#"],         request.pro)      ? 100 : 0;
        score += exact_(row, map, ["INVOICE", "INVOICE NO.", "PO#"], request.invoice) ?  50 : 0;
        score += exact_(row, map, ["CUSTOMER", "NOTE", "DC"],       request.customer) ?  20 : 0;
        score += exact_(row, map, ["SHIP DATE", "PU", "DATE"],      request.shipDate) ?  10 : 0;
        if (score) candidates.push({ row: r + 1, score });
      }

      candidates.sort((a, b) => b.score - a.score);
      if (!candidates.length || (candidates[1] && candidates[0].score === candidates[1].score)) {
        throw new Error("Could not identify one unique source row.");
      }
      return sheet.getRange(candidates[0].row, header.column);
    }

    // ─── Utility functions ────────────────────────────────────────────────────────

    /**
    * Finds the first cell in `rows` that matches one of `names` (case-insensitive).
    * @param {string[][]} rows
    * @param {string[]}   names   Header labels to search for.
    * @param {number=}    maxRows Optional limit; avoids the need for .slice().
    * @returns {{ row: number, column: number } | null}  1-based indices.
    */
    function findHeader_(rows, names, maxRows) {
      const limit = (maxRows != null) ? Math.min(maxRows, rows.length) : rows.length;
      const nameSet = new Set(names.map(n => n.toUpperCase()));
      for (let r = 0; r < limit; r++) {
        for (let c = 0; c < rows[r].length; c++) {
          if (nameSet.has(String(rows[r][c] || "").trim().toUpperCase())) {
            return { row: r + 1, column: c + 1 };
          }
        }
      }
      return null;
    }

    /**
    * Builds a map of { UPPER_HEADER_NAME → column index (0-based) } from a
    * single header row.
    * @param {string[]} headers
    * @returns {Object<string, number>}
    */
    function headerMap_(headers) {
      return headers.reduce((map, value, index) => {
        map[String(value || "").trim().toUpperCase()] = index;
        return map;
      }, {});
    }

    /**
    * Returns true when the cell identified by any of `names` in `map` contains a
    * value that exactly or partially matches `expected` (after upper-casing and
    * splitting on common delimiters).
    */
    function exact_(row, map, names, expected) {
      const wanted = String(expected || "").trim().toUpperCase();
      if (!wanted) return false;
      const wantedParts = wanted.split(/[\r\n,;·]+/).map(p => p.trim()).filter(Boolean);

      for (const name of names) {
        if (map[name] === undefined) continue;
        const cellVal = String(row[map[name]] || "").trim().toUpperCase();
        if (cellVal === wanted) return true;
        const parts = cellVal.split(/[\r\n,;·]+/).map(p => p.trim()).filter(Boolean);
        if (parts.some(p => wantedParts.includes(p))) return true;
      }
      return false;
    }

    /**
    * Returns the trimmed string value of the first matching column in `names`.
    */
    function exactVal_(row, map, names) {
      for (const n of names) {
        if (map[n] !== undefined && row[map[n]]) return String(row[map[n]]).trim();
      }
      return "";
    }

    /** Wraps a plain object as a JSON HTTP response. */
    function json_(value) {
      return ContentService
        .createTextOutput(JSON.stringify(value))
        .setMimeType(ContentService.MimeType.JSON);
    }

    function normalizeWmsShipDate_(value) {
      const text = String(value || "").trim();
      const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
      if (!match) return text.toUpperCase();
      let year = Number(match[3]);
      if (year < 100) year += 2000;
      return [year, String(Number(match[1])).padStart(2, "0"), String(Number(match[2])).padStart(2, "0")].join("-");
    }

    /**
    * Atomically posts matching SKW_Inbound product rows into SKW_Stock. Stock_Posted
    * and the composite Source_IB_ID make repeated completed-status requests idempotent.
    */
    function transferInboundInventory_(spreadsheet, request) {
      const inbound = spreadsheet.getSheetByName(SKW_INBOUND_SHEET);
      const stock = spreadsheet.getSheetByName(SKW_STOCK_SHEET);
      if (!inbound || !stock) throw new Error("SKW inventory backend tabs are missing.");
      if (inbound.getLastRow() < 2) return { movedRows: 0, quantity: 0 };

      const values = inbound.getDataRange().getDisplayValues();
      const map = headerMap_(values[0]);
      ["IB_ID", "SKU", "PRODUCT_DESCRIPTION", "QTY_EA", "STATUS", "STOCK_POSTED"].forEach(function(header) {
        if (map[header] === undefined) throw new Error(SKW_INBOUND_SHEET + " is missing " + header + ".");
      });
      const references = [request.shipmentNo, request.invoice, request.container, request.mbl, request.hbl]
        .flatMap(referenceTokens_)
        .filter(Boolean);
      if (!references.length) throw new Error("Inventory transfer requires a shipment reference.");

      const rows = [];
      for (let index = 1; index < values.length; index++) {
        const row = values[index];
        const posted = String(row[map["STOCK_POSTED"]] || "").trim().toUpperCase();
        if (/^(TRUE|YES|POSTED|1)$/.test(posted)) continue;
        const rowStatus = String(row[map["STATUS"]] || "").trim().toUpperCase();
        if (COMPLETED_STATUSES.has(rowStatus)) continue;
        const candidates = [row[map["IB_ID"]], row[map["PO_NUMBER"]], row[map["SOURCE_MSG_ID"]]]
          .flatMap(referenceTokens_)
          .filter(Boolean);
        if (references.some(function(reference) { return candidates.some(function(candidate) { return referencesMatch_(reference, candidate); }); })) {
          rows.push({ rowNumber: index + 1, values: row });
        }
      }
      if (!rows.length) return { movedRows: 0, quantity: 0 };

      const stockValues = stock.getDataRange().getDisplayValues();
      const stockMap = headerMap_(stockValues[0]);
      ["SKU", "UPC", "PRODUCT_DESCRIPTION", "BATCH_NO", "EXPIRY_DATE", "QTY_EA", "LOCATION", "SOURCE_IB_ID", "RECEIVED_AT", "UPDATED_AT"].forEach(function(header) {
        if (stockMap[header] === undefined) throw new Error(SKW_STOCK_SHEET + " is missing " + header + ".");
      });
      const postedKeys = new Set(stockValues.slice(1).map(function(row) {
        return String(row[stockMap["SOURCE_IB_ID"]] || "").trim().toUpperCase();
      }).filter(Boolean));

      let totalQuantity = 0;
      let movedRows = 0;
      const now = new Date();
      rows.forEach(function(record) {
        const row = record.values;
        const ibId = row[map["IB_ID"]] || request.shipmentNo || request.invoice || "";
        const sku = row[map["SKU"]] || "";
        const upc = row[map["UPC"]] || "";
        const product = row[map["PRODUCT_DESCRIPTION"]] || "";
        const batch = row[map["BATCH_NO"]] || "";
        const expiration = row[map["EXPIRY_DATE"]] || "";
        const quantity = Number(String(row[map["QTY_EA"]] || "0").replace(/,/g, "")) || 0;
        if (quantity <= 0) return;
        const location = row[map["LOCATION"]] || "UNASSIGNED";
        const sourceKey = [ibId, sku || upc, batch, expiration]
          .map(function(value) { return String(value || "").trim().toUpperCase(); })
          .join("::");
        if (postedKeys.has(sourceKey)) {
          inbound.getRange(record.rowNumber, map["STOCK_POSTED"] + 1).setValue(true);
          return;
        }
        stock.appendRow([sku, upc, product, batch, expiration, quantity, location, sourceKey, now, now]);
        postedKeys.add(sourceKey);
        if (map["RECEIVED_DATE"] !== undefined) inbound.getRange(record.rowNumber, map["RECEIVED_DATE"] + 1).setValue(now);
        inbound.getRange(record.rowNumber, map["STATUS"] + 1).setValue("Received");
        inbound.getRange(record.rowNumber, map["STOCK_POSTED"] + 1).setValue(true);
        totalQuantity += quantity;
        movedRows++;
      });
      return { movedRows, quantity: totalQuantity };
    }

    function referenceTokens_(value) {
      return String(value || "")
        .split(/[\r\n,;|]+/)
        .map(function(token) { return token.trim().toUpperCase(); })
        .filter(Boolean);
    }

    function referencesMatch_(left, right) {
      const a = String(left || "").replace(/[^A-Z0-9]/g, "");
      const b = String(right || "").replace(/[^A-Z0-9]/g, "");
      if (!a || !b) return false;
      if (a === b) return true;
      const shorter = Math.min(a.length, b.length);
      const longer  = Math.max(a.length, b.length);
      if (shorter < 8) return false;
      if (shorter / longer < 0.6) return false;
      return a.includes(b) || b.includes(a);
    }

    // ─── WMS Trucking import ──────────────────────────────────────────────────────

    /**
    * Detects which columns in the WMS header rows correspond to the logical fields
    * defined in WMS_COLUMN_SPECS.  Returns null if the mandatory "shipMethod"
    * column cannot be found.
    *
    * @param {string[][]} rows - Up to 5 rows from the top of the WMS sheet.
    * @returns {{ headerRowIdx: number, cols: Object<string, number> } | null}
    */
    function detectWmsColumns_(rows) {
      for (let r = 0; r < rows.length; r++) {
        const row  = rows[r].map(c => String(c || "").trim().toUpperCase());
        const cols = {};
        for (const [key, keywords] of Object.entries(WMS_COLUMN_SPECS)) {
          const idx = row.findIndex(val => keywords.some(kw => val.includes(kw)));
          if (idx !== -1) cols[key] = idx;
        }
        if (cols.shipMethod !== undefined) return { headerRowIdx: r, cols };
      }
      return null;
    }

    /**
    * Periodically scans the WMS "Invoice and Issues" sheet for rows where
    * "Shipping Method" is "Trucking", combines multiple invoices for the same
    * customer + ship date, and imports / updates rows in "WH Trucking Request".
    *
    * Designed to run via a 30-minute time-driven trigger (see create30MinTrigger).
    */
    function scanAndImportWmsTruckingOrders() {
      const lock = LockService.getScriptLock();
      if (!lock.tryLock(10000)) return { ok: false, error: "Lock timeout" };

      try {
        // Open both spreadsheets.  Let errors propagate — a failed open means the
        // IDs or permissions are wrong and needs investigation, not silent fallback.
        const wmsSpreadsheet    = SpreadsheetApp.openById(WMS_SPREADSHEET_ID);
        const targetSpreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);

        const sourceSheet = wmsSpreadsheet.getSheets()[0]; // First sheet in WMS workbook
        const targetSheet = targetSpreadsheet.getSheetByName("WH Trucking Request");
        if (!sourceSheet || !targetSheet) {
          Logger.log("WMS source sheet or 'WH Trucking Request' not found.");
          return { ok: false, error: "Source or target sheet missing." };
        }

        const sourceData = sourceSheet.getDataRange().getDisplayValues();
        if (sourceData.length < 2) return { ok: true, imported: 0, updated: 0 };

        // ── Locate header row and column indices ───────────────────────────────
        const headerInfo = detectWmsColumns_(sourceData.slice(0, 5));
        if (!headerInfo) {
          Logger.log("Shipping Method column not found in WMS sheet.");
          return { ok: false, error: "Shipping Method column missing." };
        }
        const { headerRowIdx, cols } = headerInfo;

        /** Reads a cell value by logical column key, returning "" if absent. */
        function cellOf(row, key) {
          return cols[key] !== undefined ? String(row[cols[key]] || "").trim() : "";
        }

        // ── Group Trucking rows by (Customer + Ship Date) ──────────────────────
        const groups = new Map();
        for (let r = headerRowIdx + 1; r < sourceData.length; r++) {
          const row = sourceData[r];
          if (cellOf(row, "shipMethod").toUpperCase() !== "TRUCKING") continue;

          const customer = cellOf(row, "customer");
          const shipDate = cellOf(row, "shipDate");
          const normCust = customer.toUpperCase().replace(/\s+/g, " ").trim();
          const normDate = shipDate.toUpperCase().trim();
          // Fall back to row index as key when customer is missing to avoid merging unrelated blanks.
          const groupKey = normCust ? `${normCust}___${normDate}` : `UNKNOWN___${r}`;

          if (!groups.has(groupKey)) groups.set(groupKey, []);
          groups.get(groupKey).push({
            invoice:  cellOf(row, "invoice"),
            customer,
            shipDate,
            pallets:  cellOf(row, "pallets"),
            carrier:  cellOf(row, "carrier"),
            pro:      cellOf(row, "pro"),
            note:     cellOf(row, "note"),
            rowIndex: r + 1,
          });
        }

        // ── Build lookup map from existing target rows ─────────────────────────
        const targetData    = targetSheet.getDataRange().getDisplayValues();
        const targetHeaders = targetData.length > 0 ? (targetData[1] || targetData[0]) : [];
        const targetMap     = headerMap_(targetHeaders);

        // Maps "CUST___DATE" and "INV___<invoice>" → 1-based row index.
        const existingRowsMap = new Map();
        for (let r = 2; r < targetData.length; r++) {
          const row  = targetData[r];
          const invs = exactVal_(row, targetMap, ["INVOICE NO.", "INVOICE #", "INVOICE"])
            .split(/[\r\n,;·]+/);
          const cust = exactVal_(row, targetMap, ["CUSTOMER"]).toUpperCase().replace(/\s+/g, " ").trim();
          const date = exactVal_(row, targetMap, ["SHIP DATE"]).toUpperCase().trim();

          if (cust && date) existingRowsMap.set(`${cust}___${date}`, r + 1);
          for (const inv of invs) {
            const clean = inv.trim().toUpperCase();
            if (clean) existingRowsMap.set(`INV___${clean}`, r + 1);
          }
        }

        // ── Process each group: update or collect for batch append ────────────
        let importedCount = 0;
        let updatedCount  = 0;
        const rowsToAppend = [];

        groups.forEach((items) => {
          const customer        = items[0].customer;
          const shipDate        = items[0].shipDate;
          const unique          = arr => [...new Set(arr.filter(Boolean))];
          const combinedInvoices = unique(items.map(i => i.invoice)).join("\n");
          const combinedCarrier  = items.map(i => i.carrier).find(Boolean) || "Trucking";
          const combinedPro      = unique(items.map(i => i.pro)).join("\n");
          const combinedPallets  = unique(items.map(i => i.pallets)).join(" · ");
          const combinedNote     = unique(items.map(i => i.note)).join(" · ")
                                  || "Imported from WMS Invoice & Issues";

          const normCust  = customer.toUpperCase().replace(/\s+/g, " ").trim();
          const normDate  = shipDate.toUpperCase().trim();
          const matchKey  = `${normCust}___${normDate}`;

          let matchedRowIdx = existingRowsMap.get(matchKey);
          if (!matchedRowIdx) {
            for (const item of items) {
              const key = item.invoice ? `INV___${item.invoice.toUpperCase()}` : null;
              if (key && existingRowsMap.has(key)) {
                matchedRowIdx = existingRowsMap.get(key);
                break;
              }
            }
          }

          if (matchedRowIdx) {
            // Only update the invoice cell when the combined list has changed.
            const invCol = targetMap["INVOICE NO."] ?? targetMap["INVOICE #"];
            if (invCol !== undefined && combinedInvoices) {
              const rowRange  = targetSheet.getRange(matchedRowIdx, 1, 1, Math.max(targetHeaders.length, 21));
              const curInvs   = String(rowRange.getDisplayValues()[0][invCol] || "").trim();
              if (curInvs !== combinedInvoices) {
                targetSheet.getRange(matchedRowIdx, invCol + 1).setValue(combinedInvoices);
                updatedCount++;
              }
            }
          } else {
            // Build the new row array keyed by target header positions.
            const newRow = new Array(Math.max(targetHeaders.length, 21)).fill("");
            const set = (keys, val) => {
              for (const k of keys) {
                if (targetMap[k] !== undefined) { newRow[targetMap[k]] = val; return; }
              }
            };
            set(["CUSTOMER"],                         customer);
            set(["INVOICE NO.", "INVOICE #"],         combinedInvoices);
            set(["SHIP DATE"],                        shipDate);
            set(["PALLET TYPE"],                      combinedPallets);
            set(["CARRIER"],                          combinedCarrier);
            set(["PRO#"],                             combinedPro);
            set(["NOTE"],                             combinedNote);
            set(["STATUS"],                           "WORK IN PROGRESS");
            rowsToAppend.push(newRow);
          }
        });

        // Batch-write all new rows in a single API call (dramatically faster than
        // calling appendRow() N times inside the loop above).
        if (rowsToAppend.length) {
          targetSheet.getRange(
            targetSheet.getLastRow() + 1, 1,
            rowsToAppend.length, rowsToAppend[0].length
          ).setValues(rowsToAppend);
          importedCount = rowsToAppend.length;
        }

        SpreadsheetApp.flush();
        Logger.log(`WMS scan done — groups: ${groups.size}, imported: ${importedCount}, updated: ${updatedCount}`);
        return { ok: true, groups: groups.size, imported: importedCount, updated: updatedCount };
      } catch (err) {
        Logger.log(`Error in scanAndImportWmsTruckingOrders: ${err.message}`);
        return { ok: false, error: err.message };
      } finally {
        lock.releaseLock();
      }
    }

    // ─── Trigger management ───────────────────────────────────────────────────────

    /**
    * @deprecated Use setupAllTriggers() in Triggers.gs instead — it provisions
    * all time-driven jobs (Gmail, WMS, inventory, redeploy) from one manifest.
    * Keeping this wrapper so existing bookmarks or run-history entries still work.
    */
    function create30MinTrigger() {
      if (typeof setupAllTriggers === "function") {
        Logger.log("Delegating to setupAllTriggers() in Triggers.gs (canonical trigger manager).");
        return setupAllTriggers();
      }
      const triggers = ScriptApp.getProjectTriggers();
      for (let i = 0; i < triggers.length; i++) {
        if (triggers[i].getHandlerFunction() === "scanAndImportWmsTruckingOrders") {
          ScriptApp.deleteTrigger(triggers[i]);
        }
      }
      ScriptApp.newTrigger("scanAndImportWmsTruckingOrders")
        .timeBased()
        .everyMinutes(30)
        .create();
      Logger.log("Standalone WMS trigger provisioned (Triggers.gs not available).");
    }

    // ─── One-time setup utilities ─────────────────────────────────────────────────

    /**
    * Adds or locates a "WEBSITE STATUS" dropdown column on each tracked sheet in
    * LOGISTICS MASTER 2026 and applies data-validation rules to it.
    */
    function addWebsiteStatusDropdownToAllSourceSheets() {
      const EXCLUDED_IDS = new Set([
        "14lH9SQzTLj8MR7UbxMfkoTDDlzhPoE8CqHV3IpK450I",
        "12Aty04yiLPPqz06AFDM8Y1Log2jEOqdXDqwiUV5yVX8",
      ]);

      const targetSpreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
      if (EXCLUDED_IDS.has(targetSpreadsheet.getId())) {
        Logger.log("Target spreadsheet is in excluded list. Skipping.");
        return { ok: false, error: "Spreadsheet excluded." };
      }

      const TARGET_TABS = [
        "TRANSFERS", "ULTA", "IHERB", "B2B/E-COM TRUCKING",
        "WH Trucking Request", "NATIONAL ORDER PROGRESS",
        "Outbound Shipping Schedule", "TJX/ROSS",
      ];

      // Reuse OUTBOUND_STATUS values (without the empty sentinel) for the dropdown.
      const STATUS_LIST = OUTBOUND_STATUS.filter(Boolean);

      const rule = SpreadsheetApp.newDataValidation()
        .requireValueInList(STATUS_LIST, true)
        .setAllowInvalid(false)
        .setHelpText("Select a valid Website Status from the list.")
        .build();

      let modifiedCount = 0;

      for (const tabName of TARGET_TABS) {
        const sheet = targetSpreadsheet.getSheetByName(tabName);
        if (!sheet) {
          Logger.log(`Sheet not found: ${tabName}`);
          continue;
        }

        const lastRow = sheet.getLastRow();
        if (lastRow < 1) continue;

        // Find the "WEBSITE STATUS" column if it already exists.
        const headers      = sheet.getRange(1, 1, Math.min(3, lastRow), sheet.getLastColumn()).getDisplayValues();
        let headerRowIdx   = 1;
        let colIdx         = -1;

        outer: for (let r = 0; r < headers.length; r++) {
          const row = headers[r].map(c => String(c || "").trim().toUpperCase());
          for (let c = 0; c < row.length; c++) {
            if (row[c] === "WEBSITE STATUS") {
              headerRowIdx = r + 1;
              colIdx       = c + 1;
              break outer;
            }
          }
        }

        // Column absent — append it.
        if (colIdx === -1) {
          colIdx       = sheet.getLastColumn() + 1;
          headerRowIdx = 2; // Standard header row for these tabs
          sheet.getRange(headerRowIdx, colIdx).setValue("WEBSITE STATUS").setFontWeight("bold");
        }

        const startRow = headerRowIdx + 1;
        const numRows  = Math.max(lastRow - headerRowIdx, 100);
        sheet.getRange(startRow, colIdx, numRows, 1).setDataValidation(rule);

        modifiedCount++;
        Logger.log(`Applied WEBSITE STATUS dropdown to '${tabName}' (col ${colIdx})`);
      }

      SpreadsheetApp.flush();
      return { ok: true, sheetsUpdated: modifiedCount };
    }

    /**
    * Deletes non-essential tabs from LOGISTICS MASTER 2026 using a
    * case-insensitive match so variant capitalisations do not need to be listed.
    */
    function deleteUnnecessaryTabs() {
      const TABS_TO_DELETE = new Set([
        "DIMENSIONS", "REFERENCE", "SUMMARY", "DASHBOARD",
        "OUTBOUND DATA", "INBOUND_DATA", "INBOUND DATA",
      ]);

      const targetSpreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
      let deletedCount = 0;

      for (const sheet of targetSpreadsheet.getSheets()) {
        if (TABS_TO_DELETE.has(sheet.getName().toUpperCase())) {
          Logger.log(`Deleting tab: ${sheet.getName()}`);
          targetSpreadsheet.deleteSheet(sheet);
          deletedCount++;
        }
      }

      SpreadsheetApp.flush();
      return { ok: true, tabsDeleted: deletedCount };
    }
