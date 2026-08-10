from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected exactly one match in {path}, found {count}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1))

page = "app/page.tsx"
css = "app/globals.css"
e2e = "e2e/dashboard.spec.ts"

replace_once(
    page,
    'const SALES_SHEET_URL = `https://docs.google.com/spreadsheets/d/${SALES_SHEET_ID}/edit?gid=0#gid=0`;\n',
    'const SALES_SHEET_URL = `https://docs.google.com/spreadsheets/d/${SALES_SHEET_ID}/edit?gid=0#gid=0`;\n'
    'const FULFILLMENT_SALES_URL = "https://sk-b2b-mobile.github.io/fulfillment/sales.html";\n'
    'const FULFILLMENT_API_URL =\n'
    '  "https://script.google.com/macros/s/AKfycbykK9DWjem9ORHxfR_mpdZl5DVh-en0D6JpCdIuel305QmfqxoNU_NqSnjkhFk401hI/exec";\n',
)

replace_once(
    page,
    '  sourceType?: string;\n  department?: OutboundDepartment;\n};\n',
    '  sourceType?: string;\n  department?: OutboundDepartment;\n  fulfillment?: FulfillmentTkJob;\n};\n',
)

replace_once(
    page,
    'type InventoryCollections = {\n  inbound: InventoryItem[];\n  inStock: InventoryItem[];\n};\n',
    'type InventoryCollections = {\n  inbound: InventoryItem[];\n  inStock: InventoryItem[];\n};\n\n'
    'type FulfillmentTkJob = {\n'
    '  invoice?: unknown;\n'
    '  remarks?: unknown;\n'
    '  shipDate?: unknown;\n'
    '  method?: unknown;\n'
    '  amount?: unknown;\n'
    '  inspection?: unknown;\n'
    '  inspEnd?: unknown;\n'
    '  movedToPacking?: unknown;\n'
    '  dimsCount?: unknown;\n'
    '  dimIncludedIn?: unknown;\n'
    '  pickStart?: unknown;\n'
    '  pickComplete?: unknown;\n'
    '  status?: unknown;\n'
    '  pickAnomaly?: unknown;\n'
    '  [key: string]: unknown;\n'
    '};\n\n'
    'type FulfillmentTkLoad = {\n'
    '  jobs: FulfillmentTkJob[];\n'
    '  error: string;\n'
    '};\n',
)

replace_once(
    page,
    'const SOURCE_LEGEND = [\n  "Wholesale",\n',
    'const SOURCE_LEGEND = [\n  "Wholesale",\n  "Fulfillment TK",\n',
)

replace_once(
    page,
    '  if (normalized === "wholesale") return "source-wholesale";\n',
    '  if (normalized === "wholesale") return "source-wholesale";\n'
    '  if (normalized === "fulfillment tk") return "source-fulfillment-tk";\n',
)

insert_after_optional = '''async function fetchOptionalSheet(sheetName: string, range: string) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq`);
  url.searchParams.set("tqx", "out:json");
  url.searchParams.set("sheet", sheetName);
  url.searchParams.set("range", range);
  url.searchParams.set("headers", "1");
  url.searchParams.set("_", String(Date.now()));
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) return null;
  try {
    return parseGviz(await response.text());
  } catch {
    return null;
  }
}
'''
fulfillment_helpers = insert_after_optional + '''
function parseFulfillmentDate(value: unknown) {
  const text = clean(value);
  const iso = text.match(/^(\\d{4})-(\\d{1,2})-(\\d{1,2})$/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  return parseDate(text);
}

function fulfillmentBool(value: unknown) {
  return value === true || /^(TRUE|YES|1)$/i.test(clean(value));
}

function fulfillmentTkStatus(job: FulfillmentTkJob) {
  const inspection = clean(job.inspection);
  if (/ISSUE|HOLD|ERROR|MISMATCH/i.test(inspection) || fulfillmentBool(job.pickAnomaly)) {
    return "Pending";
  }
  const hasProgress = Boolean(
    clean(job.pickStart) ||
      fulfillmentBool(job.pickComplete) ||
      inspection ||
      fulfillmentBool(job.movedToPacking) ||
      Number(job.dimsCount || 0) > 0,
  );
  return hasProgress ? "Work in Progress" : "Scheduled";
}

async function fetchFulfillmentTkJobs(): Promise<FulfillmentTkLoad> {
  try {
    const url = new URL(FULFILLMENT_API_URL);
    url.searchParams.set("op", "getSalesOverview");
    url.searchParams.set("t", String(Date.now()));
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Fulfillment read failed (${response.status}).`);
    const payload = await response.json();
    if (payload?.ok === false) throw new Error(clean(payload.error) || "Fulfillment source rejected the request.");
    const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    return {
      jobs: jobs.filter((job: FulfillmentTkJob) => clean(job.method).toUpperCase() === "TK"),
      error: "",
    };
  } catch (error) {
    return {
      jobs: [],
      error: error instanceof Error ? error.message : "Fulfillment TK source could not be loaded.",
    };
  }
}

function fulfillmentTkItems(jobs: FulfillmentTkJob[]): ScheduleItem[] {
  return jobs.flatMap((job, index) => {
    const shipDate = clean(job.shipDate);
    const date = parseFulfillmentDate(shipDate);
    if (!date) return [];
    const invoice = clean(job.invoice);
    const customer = clean(job.remarks) || "TK Fulfillment";
    const amount = parseMoney(clean(job.amount));
    const inspection = clean(job.inspection);
    const dimsCount = Number(job.dimsCount || 0) || 0;
    const pickLabel = fulfillmentBool(job.pickComplete)
      ? "Picking complete"
      : clean(job.pickStart)
        ? "Picking active"
        : "Picking waiting";
    const secondary = [
      "FULFILLMENT TK",
      pickLabel,
      inspection ? `Inspection: ${inspection}` : "",
      fulfillmentBool(job.movedToPacking) ? "Moved to packing" : "",
      dimsCount ? `Dims: ${dimsCount}` : "",
      amount ? `Amount: ${moneyWithCents(amount)}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return [
      {
        id: `fulfillment-tk-${normalizedIdentifier(invoice) || index}`,
        direction: "outbound" as const,
        date,
        dateText: shipDate,
        title: customer,
        reference: invoice || "TK fulfillment order",
        secondary,
        status: fulfillmentTkStatus(job),
        sourceSheet: "SK Fulfillment Sales · TK",
        sourceRow: index + 1,
        sourceUrl: FULFILLMENT_SALES_URL,
        editable: false,
        customer,
        customerNo: customer,
        invoice,
        carrier: "TK",
        shipDate,
        shippingMethod: "Trucking",
        sourceType: "Fulfillment TK",
        department: "B2B/E-Com" as const,
        fulfillment: job,
      },
    ];
  });
}
'''
replace_once(page, insert_after_optional, fulfillment_helpers)

replace_once(
    page,
    '  const [warehouseStock, setWarehouseStock] = useState<InventoryItem[]>([]);\n  const [selectedInventory, setSelectedInventory] = useState<InventoryItem | null>(null);\n',
    '  const [warehouseStock, setWarehouseStock] = useState<InventoryItem[]>([]);\n'
    '  const [selectedInventory, setSelectedInventory] = useState<InventoryItem | null>(null);\n'
    '  const [fulfillmentTkJobs, setFulfillmentTkJobs] = useState<FulfillmentTkJob[]>([]);\n'
    '  const [fulfillmentTkError, setFulfillmentTkError] = useState("");\n',
)

replace_once(
    page,
    '        salesOutbound,\n        liveKpis,\n',
    '        salesOutbound,\n        fulfillmentTk,\n        liveKpis,\n',
)
replace_once(
    page,
    '        fetchTable(SALES_SHEET_ID, 0, "A2:AF4200", 1),\n        fetchLiveKpis(),\n',
    '        fetchTable(SALES_SHEET_ID, 0, "A2:AF4200", 1),\n'
    '        fetchFulfillmentTkJobs(),\n'
    '        fetchLiveKpis(),\n',
)
replace_once(
    page,
    '      const importItems = pendingImportItems(imports);\n',
    '      setFulfillmentTkJobs(fulfillmentTk.jobs);\n'
    '      setFulfillmentTkError(fulfillmentTk.error);\n'
    '      const importItems = pendingImportItems(imports);\n',
)
replace_once(
    page,
    '        ...salesOutboundItems(salesOutbound),\n      ]));\n',
    '        ...salesOutboundItems(salesOutbound),\n'
    '        ...fulfillmentTkItems(fulfillmentTk.jobs),\n'
    '      ]));\n',
)

counts_block = '''  const counts = useMemo(() => {
    const today = dayKey(days[0]);
    const inbound = inboundScheduleVisibleItems.length + inboundParcelVisibleItems.length;
    const outbound = outboundVisibleItems.length + outboundParcelVisibleItems.length;
    const dueToday = visibleItems.filter((item) => dayKey(item.date) === today).length;
    const exceptions = visibleItems.filter((item) =>
      /pending|delay|hold|review/i.test(item.status),
    ).length;
    return { inbound, outbound, dueToday, exceptions };
  }, [days, outboundParcelVisibleItems, outboundVisibleItems, visibleItems]);
'''
counts_plus = counts_block + '''
  const fulfillmentTkSummary = useMemo(() => {
    const today = dayKey(days[0]);
    let dueToday = 0;
    let amount = 0;
    fulfillmentTkJobs.forEach((job) => {
      const date = parseFulfillmentDate(job.shipDate);
      if (date && dayKey(date) === today) dueToday += 1;
      amount += parseMoney(clean(job.amount));
    });
    return { count: fulfillmentTkJobs.length, dueToday, amount };
  }, [days, fulfillmentTkJobs]);
'''
replace_once(page, counts_block, counts_plus)

replace_once(
    page,
    '''              <a className="button secondary" href={SALES_SHEET_URL} target="_blank" rel="noreferrer">
                SALES
              </a>
''',
    '''              <a className="button secondary" href={SALES_SHEET_URL} target="_blank" rel="noreferrer">
                SALES
              </a>
              <a className="button secondary" href={FULFILLMENT_SALES_URL} target="_blank" rel="noreferrer">
                FULFILLMENT TK
              </a>
''',
)

replace_once(
    page,
    '{error ? "Workbook connection needs attention" : loading ? "Syncing live records…" : "3 live workbooks connected"}',
    '{error\n              ? "Workbook connection needs attention"\n              : loading\n                ? "Syncing live records…"\n                : fulfillmentTkError\n                  ? "3 core workbooks connected · TK source needs attention"\n                  : "4 live sources connected"}',
)
replace_once(page, 'AUTO SYNC 30 MIN · LAST SYNC', 'AUTO SYNC 15 MIN · LAST SYNC')

metrics_tail = '''        <article className={counts.exceptions ? "metric-alert" : ""}>
          <span>EXCEPTIONS</span>
          <strong>{counts.exceptions}</strong>
          <small>pending / hold / delayed</small>
        </article>
      </section>
'''
metrics_new = '''        <article className={counts.exceptions ? "metric-alert" : ""}>
          <span>EXCEPTIONS</span>
          <strong>{counts.exceptions}</strong>
          <small>pending / hold / delayed</small>
        </article>
        <article className={`metric-fulfillment ${fulfillmentTkError ? "metric-source-error" : ""}`}>
          <span>FULFILLMENT · TK</span>
          <strong>{fulfillmentTkError ? "!" : fulfillmentTkSummary.count}</strong>
          <small>
            {fulfillmentTkError
              ? "source unavailable · open dashboard"
              : `${fulfillmentTkSummary.dueToday} due today · ${moneyWithCents(fulfillmentTkSummary.amount)}`}
          </small>
          <a
            className="metric-card-link"
            href={FULFILLMENT_SALES_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Open SK Fulfillment Sales dashboard"
          />
        </article>
      </section>
'''
replace_once(page, metrics_tail, metrics_new)

# CSS: distinct source color, four source buttons, five top metrics, linked-card affordance.
replace_once(
    css,
    '  --source-wholesale: #7556a8;\n',
    '  --source-wholesale: #7556a8;\n  --source-fulfillment-tk: #d18a2d;\n',
)
replace_once(css, '.source-buttons { display: grid; grid-template-columns: repeat(3, 1fr); }', '.source-buttons { display: grid; grid-template-columns: repeat(4, 1fr); }')
replace_once(css, '  grid-template-columns: repeat(4, 1fr);\n  gap: 7px;\n  margin-top: 8px;\n', '  grid-template-columns: repeat(5, 1fr);\n  gap: 7px;\n  margin-top: 8px;\n')
replace_once(
    css,
    '.metrics article.metric-alert::before { background: var(--yellow); }\n',
    '.metrics article.metric-alert::before { background: var(--yellow); }\n'
    '.metrics article.metric-fulfillment::before { background: var(--source-fulfillment-tk); }\n'
    '.metric-fulfillment { overflow: hidden; }\n'
    '.metric-card-link { position: absolute; inset: 0; z-index: 2; border-radius: inherit; }\n'
    '.metric-card-link:focus-visible { outline: 3px solid var(--orange); outline-offset: -3px; }\n'
    '.metric-fulfillment::after { content: "↗"; position: absolute; right: 10px; bottom: 8px; color: var(--source-fulfillment-tk); font: 800 14px "IBM Plex Mono", monospace; }\n',
)
replace_once(
    css,
    '.source-wholesale { --source-color: var(--source-wholesale); }\n',
    '.source-wholesale { --source-color: var(--source-wholesale); }\n'
    '.source-fulfillment-tk { --source-color: var(--source-fulfillment-tk); }\n',
)
replace_once(
    css,
    '.source-buttons .button:nth-child(2) { border-radius: 0; }\n',
    '.source-buttons .button:nth-child(2),\n.source-buttons .button:nth-child(3) { border-radius: 0; }\n',
)
replace_once(
    css,
    '.metrics article.metric-alert { background: #fff3d6; border-color: #ead49d; }\n',
    '.metrics article.metric-alert { background: #fff3d6; border-color: #ead49d; }\n'
    '.metrics article.metric-fulfillment { background: #fff0d8; border-color: #e9cc95; }\n'
    '.metrics article.metric-source-error { background: #ffe5e0; border-color: #efb4aa; }\n',
)
replace_once(
    css,
    '.metrics article.metric-alert strong { color: #8a6410; }\n',
    '.metrics article.metric-alert strong { color: #8a6410; }\n'
    '.metrics article.metric-fulfillment strong { color: #956018; }\n'
    '.metrics article.metric-source-error strong { color: #a33a28; }\n',
)

# E2E: mock the external fulfillment GAS GET separately from status-write POSTs.
replace_once(
    e2e,
    '''function daysFromToday(offset: number) {
  const date = laToday();
  date.setDate(date.getDate() + offset);
  return formatDate(date);
}
''',
    '''function daysFromToday(offset: number) {
  const date = laToday();
  date.setDate(date.getDate() + offset);
  return formatDate(date);
}

function isoDaysFromToday(offset: number) {
  const date = laToday();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
''',
)

old_route = '''  await page.route("https://script.google.com/**", async (route) => {
    const payload = JSON.parse(route.request().postData() ?? "{}");
    state.postedPayload = payload;
    state.postedStatus = String(payload.status ?? "");
    return fulfill(
      route,
      JSON.stringify({ ok: true, row: payload.sourceRow }),
      "application/json",
    );
  });
'''
new_route = '''  await page.route("https://script.google.com/**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.searchParams.get("op") === "getSalesOverview") {
      return fulfill(
        route,
        JSON.stringify({
          ok: true,
          jobs: [
            {
              invoice: "INTK001",
              remarks: "TK TEST CUSTOMER",
              shipDate: isoDaysFromToday(3),
              method: "TK",
              amount: "1250.50",
              pickStart: "08:15",
              pickComplete: false,
              inspection: "",
              movedToPacking: false,
              dimsCount: 0,
            },
            {
              invoice: "INUPS001",
              remarks: "UPS SHOULD NOT IMPORT",
              shipDate: isoDaysFromToday(4),
              method: "UPS",
              amount: "99.00",
            },
          ],
        }),
        "application/json",
      );
    }
    const payload = JSON.parse(route.request().postData() ?? "{}");
    state.postedPayload = payload;
    state.postedStatus = String(payload.status ?? "");
    return fulfill(
      route,
      JSON.stringify({ ok: true, row: payload.sourceRow }),
      "application/json",
    );
  });
'''
replace_once(e2e, old_route, new_route)
replace_once(e2e, '  await expect(page.getByText("3 live workbooks connected")).toBeVisible();\n', '  await expect(page.getByText("4 live sources connected")).toBeVisible();\n')
replace_once(
    e2e,
    '  // Outbound trucking board shows the Outbound Shipping Schedule fixture.\n  await expect(page.locator(".outbound-panel")).toContainText("ULTA BEAUTY");\n',
    '  // Outbound trucking board shows the workbook fixture plus METHOD=TK fulfillment data.\n'
    '  await expect(page.locator(".outbound-panel")).toContainText("ULTA BEAUTY");\n'
    '  await expect(page.locator(".outbound-panel")).toContainText("TK TEST CUSTOMER");\n'
    '  await expect(page.locator(".outbound-panel")).toContainText("INTK001");\n'
    '  await expect(page.locator(".outbound-panel")).not.toContainText("UPS SHOULD NOT IMPORT");\n'
    '  const tkMetric = page.locator(".metric-fulfillment");\n'
    '  await expect(tkMetric).toContainText("FULFILLMENT · TK");\n'
    '  await expect(tkMetric).toContainText("1");\n'
    '  await expect(tkMetric).toContainText("$1,250.50");\n'
    '  await expect(tkMetric.locator(".metric-card-link")).toHaveAttribute(\n'
    '    "href",\n'
    '    "https://sk-b2b-mobile.github.io/fulfillment/sales.html",\n'
    '  );\n',
)

# Guardrails for the requested contract.
page_text = Path(page).read_text()
for required in [
    'clean(job.method).toUpperCase() === "TK"',
    'FULFILLMENT_SALES_URL',
    '...fulfillmentTkItems(fulfillmentTk.jobs)',
    'className="metric-card-link"',
    'AUTO SYNC 15 MIN',
]:
    if required not in page_text:
        raise SystemExit(f"Missing requested TK integration marker: {required}")

print("Fulfillment TK dashboard patch applied successfully.")
