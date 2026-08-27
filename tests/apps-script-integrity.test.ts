import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("Apps Script production integrity", () => {
  it("resolves duplicate open shipment notices against the newest matching email", () => {
    const validation = read("google-apps-script/Validation.gs");

    expect(validation).toContain("var r0 = matches[matches.length - 1]");
    expect(validation).toContain("matchedRows: matches.length");
    expect(validation).not.toContain("More than one open review row matches");
    expect(validation).not.toContain("refusing to guess");
  });

  it("records received document names and their exact Drive folder path", () => {
    const pipeline = read("google-apps-script/GmailPipelineV2.gs");
    const validation = read("google-apps-script/Validation.gs");

    expect(pipeline).toContain("meta.documentNames = documentAttachments.map");
    expect(pipeline).toContain('shipmentArchiveFolderPathV2_("Import Shipments"');
    expect(pipeline).toContain('shipmentArchiveFolderPathV2_("Outbound Shipments"');
    expect(validation).toContain("_documentNames:");
    expect(validation).toContain("_archiveFolderPath:");
    expect(validation).toContain('"Sender", "Documents", "Archive Folder"');
  });

  it("keeps Raw JSON private while publishing safe ingestion metadata", () => {
    const code = read("google-apps-script/Code.gs");
    const sources = read("worker/sources.ts");

    expect(code).toContain("const safeColumns = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17]");
    expect(sources).toContain("select A,B,C,D,E,F,G,H,I,J,K,L,M,N,P,Q,R");
    expect(sources).not.toContain('tq: "select * order by A desc limit 2000"');
  });

  it("serves an owner-authorized read snapshot for the private production workbooks", () => {
    const code = read("google-apps-script/Code.gs");
    expect(code).toContain("function doGet(e)");
    expect(code).toContain('action !== "snapshot"');
    expect(code).toContain("readSnapshotRows_");
    expect(code).toContain("NATIONAL_SPREADSHEET_ID");
    expect(code).toContain('trucking: readSnapshotRows_(master, "WH Trucking Request"');
    expect(code).toContain("const master = SpreadsheetApp.openById(SPREADSHEET_ID);");
    expect(code).not.toContain("readSnapshotRows_(SPREADSHEET_ID,");
    expect(code).toContain("function readSnapshotRows_(spreadsheet,");
    expect(code).toContain("salesOutbound: readSnapshotRows_(wms, null, 0, 2, 4199, 33)");
    expect(code).toContain("function statusSpreadsheetForSource_(sourceSheet)");
    expect(code).toContain("function ensureWmsWebsiteStatusColumn_(sheet)");
    expect(code).toContain("sheet.insertColumnsAfter(sheet.getMaxColumns(), column - sheet.getMaxColumns())");
    expect(code).toContain('header.setValue("WEBSITE STATUS")');
  });

  it("deploys the snapshot as an anonymous owner-authorized web app and smoke-tests it", () => {
    const manifest = JSON.parse(read("google-apps-script/appsscript.json"));
    const workflow = read(".github/workflows/deploy-apps-script.yml");

    expect(manifest.webapp).toEqual({
      access: "ANYONE_ANONYMOUS",
      executeAs: "USER_DEPLOYING",
    });
    expect(workflow).toContain("Verify anonymous snapshot gateway");
    expect(workflow).toContain("payload.sources?.imports");
    expect(workflow).toContain("payload.sources?.trucking");
  });

  it("uses the spreadsheet-compatible canonical FDA/FWS status vocabulary", () => {
    const code = read("google-apps-script/Code.gs");
    const gmail = read("google-apps-script/GmailPipelineV2.gs");

    expect(code).toContain('"FDA Review / Hold"');
    expect(code).toContain('"FWS Review / Hold"');
    expect(code).not.toContain('"FDA Review/Hold"');
    expect(code).not.toContain('"FWS Review/Hold"');
    expect(gmail).toContain("canonicalLogisticsStatus_(record.status)");
  });

  it("has exactly one production compatibility entry point for the legacy WMS scanner name", () => {
    const code = read("google-apps-script/Code.gs");
    const compatibility = read("google-apps-script/zz_WmsTruckingCompatibility.gs");
    const combined = `${code}\n${compatibility}`;
    const matches = combined.match(/function\s+scanAndImportWmsTruckingOrders\s*\(/g) ?? [];

    expect(matches).toHaveLength(1);
    expect(compatibility).toContain("return scanAndImportWmsTruckingOrdersV2();");
  });

  it("central trigger provisioning cleans legacy WMS/Gmail handlers and provisions the current ones", () => {
    const triggers = read("google-apps-script/Triggers.gs");

    expect(triggers).toContain('"processLogisticsEmails"');
    expect(triggers).toContain('"processLogisticsEmailsV2"');
    expect(triggers).toContain('"scanAndImportWmsTruckingOrders"');
    expect(triggers).toContain('"scanAndImportWmsTruckingOrdersV2"');
    // Emergency-disabled 2026-08-25 after the duplicate-row incident. Both
    // names remain cleanup targets so setupAllTriggers removes stale installed
    // triggers, but neither importer may be provisioned until a dry-run proves
    // the duplicate-insert root cause is fixed.
    expect(triggers).not.toContain('{ handler: "scanAndImportWmsTruckingOrdersV2",');
    expect(triggers).not.toContain('{ handler: "scanAndImportWmsTruckingOrders",');
    expect(triggers).not.toContain('{ handler: "requestSiteRedeploy"');
  });

  it("keeps the WMS trucking importer emergency-disabled after the duplicate-row incident", () => {
    const importer = read("google-apps-script/WmsTruckingSyncV2.gs");
    const code = read("google-apps-script/Code.gs");

    // Emergency-disabled 2026-08-25: live imports produced ~87 duplicate
    // rows for one KORHEIM (CANOGA PARK) shipment on WH Trucking Request.
    // Do not flip these back without confirming the duplicate-insert root
    // cause is fixed and reviewing a dry-run cycle first.
    expect(importer).toContain("var WMS_TRUCKING_SYNC_ENABLED = false;");
    expect(importer).toContain("var WMS_TRUCKING_DRY_RUN = true;");
    expect(importer).toContain("function logWmsDryRun_(");
    expect(importer).toContain("function wouldChangeMappedValue_(");
    // Word-boundary anchored — must not collapse "MEGA MARTINEZ..." into
    // "MEGA MART" the way the unanchored `indexOf(...) === 0` check used to
    // (see tests/wms-trucking-sync.test.ts for the behavioral regression test).
    expect(code).toContain('/^MEGA MART\\b/.test(key)');
    expect(code).toContain('/^TOKTOK BEAUTY\\b/.test(key)');
    expect(code).toContain('/^ROYAL IMEX\\b/.test(key)');
    expect(code).not.toContain('key.indexOf("MEGA MART") === 0');
    expect(code).not.toContain('key.indexOf("TOKTOK BEAUTY") === 0');
    expect(code).not.toContain('key.indexOf("ROYAL IMEX") === 0');
  });

  it("runs the WH Trucking Request customer-lookup create path live, after a dry-run review period", () => {
    const lookup = read("google-apps-script/CustomerLookup.gs");
    expect(lookup).toContain("var CUSTOMER_LOOKUP_ENABLED = true;");
    expect(lookup).toContain("var CUSTOMER_CREATE_DRY_RUN = false;");
    // Codex review on PR #92: a live-write caller must not treat an
    // ambiguous match (multiple existing locations for the same brand) the
    // same as a genuinely absent customer, or it creates a fresh blank
    // duplicate on top of already-known locations. Both files below guard
    // the same class of bug independently (see the NOTE ON DUPLICATED
    // HELPERS convention in CustomerBackfill.gs).
    expect(lookup).toContain("function isAmbiguousLocationFamily_(");
    expect(lookup).toContain("LockService.getScriptLock()");
    // Round 2 of the same review: matching a record created earlier in the
    // same paste must not blindly apply its address to a row with a
    // different actual address, and a dropped edit on lock timeout must be
    // observable in PIPELINE LOG, not just the executions log.
    expect(lookup).toContain("function customerAddressConflicts_(");
    expect(lookup).toContain("CUSTOMER LOOKUP LOCK TIMEOUT");
    // Round 4 of the same review: a bare onEdit(e) auto-installs as a
    // restricted simple trigger — an earlier revision promoted it to a real
    // installable trigger instead, but deploy-apps-script.yml never runs
    // setupAllTriggers(), so that would have silently disabled this whole
    // feature after every deploy. Reverted to a bare onEdit(e); every
    // PIPELINE LOG write instead goes through logPipelineFromBoundSpreadsheet_,
    // which avoids the one call (SpreadsheetApp.openById) actually
    // restricted under a simple trigger's authorization.
    expect(lookup).toContain("function onEdit(e)");
    expect(lookup).toContain("function logPipelineFromBoundSpreadsheet_(");
    expect(lookup).not.toContain("function customerLookupOnEdit(");
    // Round 5 of the same review: a same-batch stub created with a blank
    // address must get filled in once a later row in the same paste
    // supplies one, gated to an exact-name match only (a canonical-only
    // match could be a different physical location under the same brand —
    // see CustomerBackfill.gs's matchedByExactBackfillName_ below for the
    // identical risk and why the two names must differ).
    expect(lookup).toContain("function customerAddressFillable_(");
    expect(lookup).toContain("function fillCustomerAddress_(");
    expect(lookup).toContain("function matchedByExactName_(");
    // Round 6 of the same review: staff commonly type the customer name and
    // its address as two SEPARATE edits, each its own onEdit event — gating
    // on the customer column alone meant the address-only edit never
    // reached customerAddressFillable_ at all.
    expect(lookup).toContain("function shouldProcessCustomerLookupEdit_(");
    // Round 8 of the same review: matchedByExactName_ was already gating the
    // address-fill write, but the note-append itself was never gated the
    // same way — a canonical-only match (e.g. "MEGA MART (FREMONT)"
    // resolving to the lone existing "MEGA MART (PALO ALTO)" row) still
    // appended the WRONG location's contact/services into the row's NOTE.
    // logCanonicalMatchNeedsReview_ is the review-only path that now runs
    // instead of appendCustomerNote_ whenever the match isn't exact.
    expect(lookup).toContain("function logCanonicalMatchNeedsReview_(");
    expect(lookup).toContain('"canonical-match-needs-review"');
    expect(lookup).toMatch(
      /if\s*\(\s*!matchedByExactName_\(customerValue,\s*record\)\s*\)\s*\{[\s\S]*?logCanonicalMatchNeedsReview_\(/,
    );
    // Round 9 of the same review: staff typing the customer name and its
    // address as two separate edits (round 6) matches the same record
    // twice — comparing the whole combined note string against the existing
    // cell missed that a customer-only first edit had already written the
    // Contact/Services portion while the address was still blank, so
    // filling the address and re-running duplicated it. appendCustomerNote_
    // must filter per-section (customerNoteParts_), not compare the joined
    // string as one unit.
    expect(lookup).toContain("function customerNoteParts_(");
    // Round 10 of the same review: the per-section check above used raw
    // string indexOf, a substring search — a manual note like "Previous
    // Address: 123 Main St" contains the generated "Address: 123 Main St"
    // as a literal substring, so the real current value was silently
    // dropped instead of appended. Sections must be split out of the
    // existing text and compared for exact equality, not searched for as a
    // substring of the whole cell.
    expect(lookup).toContain("function existingCustomerNoteParts_(");
    expect(lookup).toMatch(/existingParts\.indexOf\(part\) === -1/);
  });

  it("runs the customer backfill batch job live, with the '- 1'/'- 2' second-location write path implemented", () => {
    const backfill = read("google-apps-script/CustomerBackfill.gs");
    expect(backfill).toContain("var CUSTOMER_BACKFILL_ENABLED = true;");
    expect(backfill).toContain("var CUSTOMER_BACKFILL_DRY_RUN = false;");
    expect(backfill).toContain("function appendBackfillCustomer_(");
    expect(backfill).toContain("function fillBackfillCustomerAddress_(");
    expect(backfill).toContain("function flagBackfillSecondLocation_(");
    // isBackfillAmbiguousLocationFamily_, not isAmbiguousLocationFamily_:
    // CustomerLookup.gs defines its OWN identically-named function, and Apps
    // Script's single flat global namespace means the last-loaded file's
    // definition silently wins for both callers, discarding the other's
    // logic — round 4 of the Codex review on PR #92 (the two copies had
    // drifted to genuinely different behavior across rounds 2/3's fixes, so
    // whichever one lost would run the wrong ambiguity check with no error).
    expect(backfill).toContain("function isBackfillAmbiguousLocationFamily_(");
    expect(backfill).not.toMatch(/function isAmbiguousLocationFamily_\(/);
    expect(backfill).toContain('"ambiguous-location-family"');
    // Every candidate is still logged to PIPELINE LOG regardless of dry-run
    // state, live or not — the audit trail must never be silently dropped.
    expect(backfill).toContain("function logCustomerBackfillCandidate_(");
    // Round 2 of Codex's PR #92 review: appending the new numbered location
    // must happen BEFORE renaming the original to "- 1", so a partial-write
    // failure self-heals instead of orphaning an unmatchable row; and an
    // already-ambiguous suffix family must still be able to append a
    // genuinely new address via appendNewFamilyLocation_/isSuffixLocationFamily_.
    expect(backfill).toContain("function appendNewFamilyLocation_(");
    expect(backfill).toContain("function isSuffixLocationFamily_(");
    expect(backfill).toContain("function hasEstablishedSuffixConvention_(");
    // Round 3 of the same review: family-membership checks must all use one
    // canonicalized base-key helper (not a mix of canonicalized ambiguity
    // checks and raw-normalized address/numbering helpers), and a partial
    // append-then-rename write must be repairable on the next run.
    expect(backfill).toContain("function canonicalFamilyBaseKey_(");
    expect(backfill).toContain("function renameToFirstLocation_(");
    expect(backfill).toContain('"would-repair-split-rename"');
    // stripBackfillLocationSuffix_, not stripCustomerLocationSuffix_: same
    // global-namespace collision reasoning as isBackfillAmbiguousLocationFamily_
    // above — CustomerLookup.gs defines its own stripCustomerLocationSuffix_
    // too. Currently byte-identical across both files (so today's collision
    // is harmless), but sharing a name across files remains fragile — a
    // future edit to either copy alone would silently resurrect the same
    // class of bug that hit isAmbiguousLocationFamily_.
    expect(backfill).toContain("function stripBackfillLocationSuffix_(");
    expect(backfill).not.toMatch(/function stripCustomerLocationSuffix_\(/);
    // Round 5 of the same review: a canonical-only match (matched via the
    // brand-alias fallback, not the literal exact name) must never mutate
    // an existing TRUCKING row — it could be a different physical location
    // under the same multi-location brand (e.g. MEGA MART Fremont resolving
    // to the lone existing Palo Alto record). matchedByExactBackfillName_,
    // not matchedByExactName_: CustomerLookup.gs defines its own identical
    // helper for the same reason, and this file's other duplicated helpers
    // are all "Backfill"-qualified to avoid exactly this collision.
    expect(backfill).toContain("function matchedByExactBackfillName_(");
    expect(backfill).not.toMatch(/function matchedByExactName_\(/);
    expect(backfill).toContain('"canonical-match-needs-review"');
    // Every mutating branch must log AFTER its write succeeds (or with an
    // explicit failure tag when the write throws), not before — see
    // logCustomerBackfillCandidate_'s writeError parameter.
    expect(backfill).toContain("CUSTOMER BACKFILL WRITE FAILED");
    // Round 6 of the same review: a write failure must stop the whole batch
    // (not just skip to the next candidate), since a failed write can leave
    // nextTruckingRow/truckingRecords out of sync with what's actually
    // persisted — continuing on a stale cursor risks a later write landing
    // on and overwriting a row a prior candidate just successfully wrote.
    // A regular for-of (not Map.forEach) so the loop can actually break.
    expect(backfill).toContain("batchStoppedEarly");
    expect(backfill).toMatch(/for\s*\(\s*var\s+entry\s+of\s+aggregation\.aggregates\s*\)/);
    // And: a brand-new customer created with 2+ known locations in one pass
    // must have its primary row renamed to "- 1" immediately, not left
    // unsuffixed until a later repair run catches it.
    expect(backfill).toContain("function createBackfillCustomerWithLocations_(");
    // Round 7 of the same review: createBackfillCustomerWithLocations_ must
    // reuse flagBackfillSecondLocation_ (which already appends a sibling
    // BEFORE renaming the primary) rather than renaming first — renaming
    // first orphans an unmatchable "- 1" row if the first sibling append
    // then fails. And the would-fill-missing-address branch must surface
    // every address beyond the first as pendingAddresses too, not just
    // would-create/would-flag-second-location/ambiguous-location-family.
    expect(backfill).toMatch(
      /function createBackfillCustomerWithLocations_[\s\S]*?flagBackfillSecondLocation_\(truckingSheet, header, truckingRecords, primaryRecord/,
    );
    // Round 8 of the same review: a stopped batch left part of the
    // reconciliation unprocessed and must read as a failure, not a quiet
    // success — otherwise a caller/operator checking the return value's
    // .ok has no way to tell a partial run from a complete one.
    expect(backfill).toMatch(/ok:\s*!batchStoppedEarly/);
    // Round 10 of the same review: the split-repair check compared the
    // broad, canonically-aliased family key (canonicalFamilyBaseKey_),
    // which collapses differently-NAMED locations sharing only a brand
    // alias (e.g. "MEGA MART (FREMONT)"/"MEGA MART (PALO ALTO)") into one
    // key — wrongly treating an exact match on one location as a partial
    // split of an unrelated sibling location. literalBackfillBaseKey_ is
    // strictly literal (case/whitespace only, no brand-alias
    // canonicalization), matching how flagBackfillSecondLocation_/
    // renameToFirstLocation_ actually derive a sibling's base name.
    expect(backfill).toContain("function literalBackfillBaseKey_(");
    expect(backfill).toMatch(
      /literalBackfillBaseKey_\(r\.name\) === literalBackfillBaseKey_\(matchedRecord\.name\)/,
    );
  });

  it("captures flattened KCC air-notice flight numbers as the inbound transport name", () => {
    const gmail = read("google-apps-script/GmailPipelineV2.gs");
    expect(gmail).toContain("if (!context.vessel && mawb)");
    expect(gmail).toContain('context.vessel = flight[1] + "-" + flight[2]');
  });

  it("does not provision an installable onEdit trigger for customer lookup (deploy-apps-script.yml never runs setupAllTriggers)", () => {
    const triggers = read("google-apps-script/Triggers.gs");
    const workflow = read(".github/workflows/deploy-apps-script.yml");
    // Round 4 of the Codex review on PR #92: deploy-apps-script.yml only
    // pushes/deploys source, never invokes setupAllTriggers() — provisioning
    // customer lookup as an installable trigger would have left it disabled
    // after every normal production deploy until a human ran setup by hand.
    // Confirm both halves: the workflow still doesn't call it (so the risk
    // is real if anything ever depended on install-time provisioning), and
    // Triggers.gs no longer tries to provision one — CustomerLookup.gs's
    // bare onEdit(e) needs no trigger installation at all.
    expect(workflow).not.toContain("setupAllTriggers");
    expect(triggers).not.toContain("EDIT_TRIGGER_PLAN");
    expect(triggers).not.toContain(".onEdit().create()");
    // Retained purely as a cleanup target for any stray installable trigger
    // left over from testing an earlier revision of this PR.
    expect(triggers).toContain('"customerLookupOnEdit"');
  });

  it("ships the broadened Gmail search and both new customer/store resolvers enabled, but not yet wired into live ingestion", () => {
    const pipeline = read("google-apps-script/GmailPipelineV2.gs");
    const customerResolver = read("google-apps-script/GmailCustomerResolverV2.gs");
    const storeResolver = read("google-apps-script/GmailStoreResolverV2.gs");
    expect(pipeline).toContain("var GMAIL_V2_BROADENED_SEARCH_ENABLED_V2 = true;");
    expect(customerResolver).toContain("var GMAIL_CUSTOMER_RESOLVER_ENABLED_V2 = true;");
    expect(storeResolver).toContain("var GMAIL_STORE_RESOLVER_ENABLED_V2 = true;");
    // Both resolvers are reviewed/tested standalone first — wiring them into
    // processLogisticsMessageV2_ lands in a follow-up PR together with the
    // insert-row helper and its own dry-run gate, since a resolved
    // record.customer would otherwise be able to reach
    // upsertOutboundEmailV2_'s existing (already-live, ungated) insert
    // branch immediately.
    expect(pipeline).not.toContain("resolveCustomerFromEmailV2_(");
    expect(pipeline).not.toContain("resolveUltaDcFromEmailV2_(");
    expect(pipeline).not.toContain("resolveTjxDcFromEmailV2_(");
  });

  it("reserves each Gmail search query its own thread-discovery share instead of a flat post-hoc slice", () => {
    const pipeline = read("google-apps-script/GmailPipelineV2.gs");
    // Codex review on PR #102: filling threadsById in query order and then
    // slicing the combined set to GMAIL_V2_MAX_THREADS let the broadened
    // query's results (always inserted last) get silently discarded
    // whenever the first two queries alone already filled every slot.
    expect(pipeline).toContain("var perQueryThreadCap = Math.ceil(GMAIL_V2_MAX_THREADS / queries.length);");
    expect(pipeline).not.toMatch(/Object\.keys\(threadsById\)\.slice\(/);
    // Round 2 of the same review: attribution (which quer(y/ies) matched a
    // thread, for the broadenedMatches metric) must be computed from the
    // full, uncapped search results — not from which threads happened to
    // win a slot under the per-query cap — or a thread that overflowed one
    // query's share could get admitted under another's and miscounted.
    expect(pipeline).toContain("var matchedByQueryIndex = {};");
    expect(pipeline).toContain("perQueryResults.forEach(function (threads, queryIndex) {");
    // And: a thread with no unprocessed message left must not consume its
    // query's admission share either, or a query that stably returns the
    // same already-fully-handled threads can permanently starve a
    // genuinely new thread ranked just below the cap. Round 6 of the same
    // review: filtering this at admission time wasn't enough either — a
    // query with more matches than fit in one page would keep re-fetching
    // the same already-processed top results forever, since Gmail search
    // has no built-in "exclude already-handled" filter. Paging past them at
    // search time (before admission) is what actually lets threads ranked
    // behind the fully-processed ones surface.
    expect(pipeline).toContain("function gmailV2AdmissibleThreadsForQueryV2_(query, deadline, offsetKey) {");
    expect(pipeline).toContain("var evaluation = gmailV2EvaluateThreadV2_(page[i]);");
    expect(pipeline).toContain(
      "return gmailV2AdmissibleThreadsForQueryV2_(query, queryDeadline, GMAIL_V2_DISCOVERY_OFFSET_PREFIX + index);",
    );
    // Round 10 of the same review: a deadline hit mid-page previously
    // abandoned the rest of that page with no memory of where it stopped —
    // every trigger invocation restarted the same query at offset 0, so a
    // stable backlog of already-seen/retry-deferred threads at the front of
    // the results could permanently starve an unseen thread ranked behind
    // it. The search offset now persists per query across runs and only
    // resets once that query's results are genuinely exhausted.
    expect(pipeline).toContain('var GMAIL_V2_DISCOVERY_OFFSET_PREFIX = "GMAIL_V2_DISCOVERY_OFFSET_";');
    expect(pipeline).toContain("var start = props ? Number(props.getProperty(offsetKey) || 0) : 0;");
    expect(pipeline).toContain("if (exhausted) props.deleteProperty(offsetKey);");
    expect(pipeline).toContain("else props.setProperty(offsetKey, String(start));");
    // A short/near-exhausted page combined with a tight deadline must not
    // be misread as "nothing left" — only a page fully evaluated before
    // deciding it's shorter than a full page counts as real exhaustion.
    expect(pipeline).toContain("if (i < page.length) break;");
    // Round 10, a second finding on the same review: "not matched by an
    // established query" is only trustworthy when that query's discovery
    // actually reached its true end-of-results this run — otherwise a
    // thread the broadened query also found could be misclassified as
    // broadened-only and forced into PENDING VERIFICATION instead of that
    // established query's normal upsert path.
    expect(pipeline).toContain("return { admissible: admissible, deferredCounts: deferredCounts, truncated: !exhausted };");
    expect(pipeline).toContain("var anyEstablishedQueryTruncated = perQueryDiscovery.some(function (discovery, queryIndex) {");
    expect(pipeline).toContain("if (broadenedQueryIndex !== -1 && !anyEstablishedQueryTruncated) {");
    expect(pipeline).toContain("function gmailV2ThreadHasUnprocessedMessageV2_(thread) {");
    expect(pipeline).toContain("return gmailV2EvaluateThreadV2_(thread).admissible;");
    // Round 7 of the same review: discovery itself must respect the run's
    // overall time budget — with 4 queries each potentially scanning up to
    // GMAIL_V2_MAX_SEARCH_SCAN already-processed threads, an unbounded
    // discovery phase could exhaust the whole run before a single message
    // is processed or the run log is written.
    expect(pipeline).toContain("var GMAIL_V2_DISCOVERY_BUDGET_MS = 60000;");
    expect(pipeline).toContain("var discoveryDeadline = runStarted + GMAIL_V2_DISCOVERY_BUDGET_MS;");
    expect(pipeline).toContain("if (Date.now() >= deadline) break;");
    // Round 8 of the same review: a shared deadline alone still let a
    // first query with a large processed/retry-deferred backlog consume
    // the ENTIRE discovery budget before any later query got a single page
    // fetched (Array.map runs each query's discovery to completion before
    // starting the next) — each query now gets its own reserved slice.
    expect(pipeline).toContain("var perQueryDiscoveryBudgetMs = Math.floor(GMAIL_V2_DISCOVERY_BUDGET_MS / queries.length);");
    expect(pipeline).toContain("var queryDeadline = Math.min(discoveryDeadline, Date.now() + perQueryDiscoveryBudgetMs);");
    // Also round 7: a thread admission rejects solely for being
    // retry-deferred (never fully seen, never past the lookback window)
    // must still surface in stats.retryDeferred — it is never admitted, so
    // the main per-message loop's own retryDeferred++ never sees it.
    expect(pipeline).toContain("function gmailV2EvaluateThreadV2_(thread) {");
    expect(pipeline).toContain("deferredCountByThreadId[id] = discovery.deferredCounts[id];");
    expect(pipeline).toContain("retryDeferred: discoveredRetryDeferred");
    // Round 5 of the same review: a per-query cap can go unused when that
    // query simply has fewer than its share of hits (e.g. only one of
    // three queries has any matches), leaving global budget idle while
    // that query's own overflow ages past the lookback window instead of
    // being processed. A second fill pass spends the leftover global
    // budget on overflow from every query.
    expect(pipeline).toContain("var overflowByQuery = [];");
    expect(pipeline).toContain("var remainingGlobalBudget = GMAIL_V2_MAX_THREADS - Object.keys(threadsById).length;");
    expect(pipeline).toContain("overflowByQuery.forEach(function (overflow) {");
  });

  it("forces every broadened-only-matched record through PENDING VERIFICATION until explicitly trusted", () => {
    const pipeline = read("google-apps-script/GmailPipelineV2.gs");
    // Codex review on PR #102: query 0 was already fully sender-agnostic
    // before this file's changes, but the broadened query's generic terms
    // ("commercial invoice", "delivery order", ...) measurably widen how
    // much untrusted-sender traffic reaches match/insert logic that can
    // mutate a live sheet with no human review at all for a matched
    // update. Starting disabled forces every broadened-only find through
    // PENDING VERIFICATION for an observation period, the same rollout
    // discipline as every other new-automation flag in this codebase.
    expect(pipeline).toContain("var GMAIL_V2_BROADENED_AUTOCOMMIT_ENABLED_V2 = false;");
    expect(pipeline).toContain("if (isBroadenedOnly && !GMAIL_V2_BROADENED_AUTOCOMMIT_ENABLED_V2) {");
    expect(pipeline).toContain("function processLogisticsMessageV2_(message, isBroadenedOnly) {");
    expect(pipeline).toContain("processLogisticsMessageV2_(message, isBroadenedOnly)");
  });

  it("only skips archiving Gmail attachments for a weak broadened-only match with zero extracted records", () => {
    const pipeline = read("google-apps-script/GmailPipelineV2.gs");
    // Codex review round 1 on PR #102: the broadened search query is
    // generic enough that an unrelated email can match with zero
    // extractable records — gating purely on documentAttachments.length
    // would still create a permanent Drive folder for a shipment that was
    // never matched or inserted anywhere.
    //
    // Codex review round 3 on PR #102: that fix over-reached — gating on
    // records.length unconditionally also stopped archiving attachments
    // for the two ORIGINAL, already-trusted queries whenever extraction
    // failed, losing the exact artifact a human needs to debug why
    // extraction failed. The zero-records skip must apply only to threads
    // found ONLY by the broadened query.
    expect(pipeline).toContain("var isWeakBroadenedMatch = isBroadenedOnly && !records.length;");
    expect(pipeline).toContain("if (documentAttachments.length && !isWeakBroadenedMatch) {");
  });
});
