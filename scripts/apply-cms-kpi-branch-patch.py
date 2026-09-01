from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1))


replace_once(
    "worker/index.ts",
    'import { fetchCmsInventory } from "./cms-inventory";\n',
    'import { fetchCmsInventory } from "./cms-inventory";\nimport { fetchCmsSalesKpis } from "./cms-sales-kpis";\n',
)
replace_once(
    "worker/index.ts",
    'const WORKER_VERSION = "2026-08-30-worker-v10-d1-inventory-reconciliation";',
    'const WORKER_VERSION = "2026-09-01-worker-v11-cms-sales-kpis";',
)
replace_once(
    "worker/index.ts",
    '''  const [raw, cmsInventory] = await Promise.all([\n    fetchOperationalSources(env.APPS_SCRIPT_WRITE_URL),\n    fetchCmsInventory(env),\n  ]);''',
    '''  const [raw, cmsInventory, cmsSalesResult] = await Promise.all([\n    fetchOperationalSources(env.APPS_SCRIPT_WRITE_URL),\n    fetchCmsInventory(env),\n    fetchCmsSalesKpis(env)\n      .then((value) => ({ ok: true as const, value }))\n      .catch((error) => ({\n        ok: false as const,\n        error: error instanceof Error ? error.message : String(error),\n      })),\n  ]);''',
)
replace_once(
    "worker/index.ts",
    '''  let kpis = null;\n  let kpiError = "";\n  try {\n    kpis = computeKpisFromRows(snapshot.kpiRows);\n  } catch (error) {\n    kpiError = error instanceof Error ? error.message : String(error);\n  }''',
    '''  let kpis = null;\n  let kpiError = "";\n  try {\n    kpis = computeKpisFromRows(snapshot.kpiRows);\n    if (cmsSalesResult.ok) {\n      kpis = {\n        ...kpis,\n        wmsSalesMtd: cmsSalesResult.value.wmsSalesMtd,\n        wmsSalesYtd: cmsSalesResult.value.wmsSalesYtd,\n      };\n      rawSources.cmsSalesKpis = cmsSalesResult.value;\n    } else {\n      rawSources.cmsSalesKpis = { ok: false, error: cmsSalesResult.error };\n      kpiError = `CMS sales unavailable; WMS sheet fallback active (${cmsSalesResult.error})`;\n    }\n  } catch (error) {\n    kpiError = error instanceof Error ? error.message : String(error);\n  }''',
)
replace_once(
    "worker/index.ts",
    "function withSecurityHeaders(response: Response) {",
    '''function cmsSalesError(error: unknown) {\n  const code = error instanceof Error ? error.message : String(error);\n  return json({ ok: false, error: code }, code === "KPI_MONTH_INVALID" ? 400 : 502);\n}\n\nasync function handleCmsSalesKpis(request: Request, env: Env) {\n  try {\n    const month = new URL(request.url).searchParams.get("month")?.trim() || undefined;\n    const result = await fetchCmsSalesKpis(env, new Date(), fetch, month);\n    return json({ ok: true, ...result });\n  } catch (error) {\n    return cmsSalesError(error);\n  }\n}\n\nasync function handleMonthlyKpis(request: Request, env: Env) {\n  try {\n    const month = new URL(request.url).searchParams.get("month")?.trim() || undefined;\n    const [raw, cmsSales] = await Promise.all([\n      fetchOperationalSources(env.APPS_SCRIPT_WRITE_URL),\n      fetchCmsSalesKpis(env, new Date(), fetch, month),\n    ]);\n    const snapshot = dedupeOperationalPayload(raw);\n    const kpis = computeKpisFromRows({\n      ...snapshot.kpiRows,\n      selectedMonth: cmsSales.selectedMonth,\n    });\n    return json({\n      ok: true,\n      month: cmsSales.selectedMonth,\n      currency: cmsSales.currency,\n      source: cmsSales.source,\n      kpis: {\n        ...kpis,\n        wmsSalesMtd: cmsSales.wmsSalesMtd,\n        wmsSalesYtd: cmsSales.wmsSalesYtd,\n      },\n    });\n  } catch (error) {\n    return cmsSalesError(error);\n  }\n}\n\nfunction withSecurityHeaders(response: Response) {''',
)
replace_once(
    "worker/index.ts",
    '''    } else if (url.pathname === "/api/logistics/reconciliation") {\n      response = request.method === "GET" ? await handleReconciliation(env) : json({ ok: false, error: "Method not allowed" }, 405);''',
    '''    } else if (url.pathname === "/api/logistics/cms-sales-kpis") {\n      response = request.method === "GET" ? await handleCmsSalesKpis(request, env) : json({ ok: false, error: "Method not allowed" }, 405);\n    } else if (url.pathname === "/api/logistics/monthly-kpis") {\n      response = request.method === "GET" ? await handleMonthlyKpis(request, env) : json({ ok: false, error: "Method not allowed" }, 405);\n    } else if (url.pathname === "/api/logistics/reconciliation") {\n      response = request.method === "GET" ? await handleReconciliation(env) : json({ ok: false, error: "Method not allowed" }, 405);''',
)

replace_once(
    "app/page.tsx",
    '''async function fetchLiveKpis() {\n  // During migration this remains a Sheets-derived fallback. Once the database\n  // is fully authoritative, the snapshot API can provide the same KPI payload.\n  return (await computeLiveKpis()) as unknown as KpiSnapshot;\n}\n''',
    '''async function fetchLiveKpis() {\n  // During migration this remains a Sheets-derived fallback. Once the database\n  // is fully authoritative, the snapshot API can provide the same KPI payload.\n  return (await computeLiveKpis()) as unknown as KpiSnapshot;\n}\n\nfunction currentMtdMonth() {\n  const today = startOfToday();\n  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;\n}\n\nfunction availableMtdMonths() {\n  const [yearText, monthText] = currentMtdMonth().split("-");\n  const year = Number(yearText);\n  const month = Number(monthText);\n  return Array.from({ length: month }, (_, index) => {\n    const value = `${year}-${String(index + 1).padStart(2, "0")}`;\n    const label = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" })\n      .format(new Date(Date.UTC(year, index, 1)));\n    return { value, label };\n  }).reverse();\n}\n\nasync function fetchMonthlyKpis(month: string): Promise<KpiSnapshot> {\n  const response = await fetch(`/api/logistics/monthly-kpis?month=${encodeURIComponent(month)}`, { cache: "no-store" });\n  const payload = await response.json().catch(() => null) as { ok?: boolean; error?: string; kpis?: KpiSnapshot } | null;\n  if (!response.ok || payload?.ok !== true || !payload.kpis) {\n    throw new Error(payload?.error || `Monthly KPI request failed (${response.status}).`);\n  }\n  return payload.kpis;\n}\n''',
)
replace_once(
    "app/page.tsx",
    '''  const [period, setPeriod] = useState<"mtd" | "ytd">("mtd");\n  const [savingId, setSavingId] = useState("");''',
    '''  const [period, setPeriod] = useState<"mtd" | "ytd">("mtd");\n  const [selectedMtdMonth, setSelectedMtdMonth] = useState(currentMtdMonth);\n  const [savingId, setSavingId] = useState("");''',
)
replace_once(
    "app/page.tsx",
    "  const visibleItems = useMemo(() => {",
    '''  useEffect(() => {\n    if (period !== "mtd") return;\n    let cancelled = false;\n    fetchMonthlyKpis(selectedMtdMonth)\n      .then((nextKpis) => {\n        if (!cancelled) setKpis(nextKpis);\n      })\n      .catch((monthlyError) => {\n        if (!cancelled) {\n          setNotice(monthlyError instanceof Error ? monthlyError.message : "Monthly KPI data is unavailable.");\n        }\n      });\n    return () => {\n      cancelled = true;\n    };\n  }, [period, selectedMtdMonth]);\n\n  const visibleItems = useMemo(() => {''',
)
replace_once(
    "app/page.tsx",
    '''          <div className="period-toggle" role="group" aria-label="KPI period">\n            <button type="button" className={period === "mtd" ? "active" : ""} onClick={() => setPeriod("mtd")}>\n              MTD\n            </button>\n            <button type="button" className={period === "ytd" ? "active" : ""} onClick={() => setPeriod("ytd")}>\n              YTD\n            </button>\n          </div>''',
    '''          <div className="kpi-period-controls">\n            <div className="period-toggle" role="group" aria-label="KPI period">\n              <button type="button" className={period === "mtd" ? "active" : ""} onClick={() => setPeriod("mtd")}>\n                MTD\n              </button>\n              <button type="button" className={period === "ytd" ? "active" : ""} onClick={() => setPeriod("ytd")}>\n                YTD\n              </button>\n            </div>\n            {period === "mtd" && (\n              <label className="mtd-month-select">\n                <span>Month</span>\n                <select aria-label="MTD month" value={selectedMtdMonth} onChange={(event) => setSelectedMtdMonth(event.target.value)}>\n                  {availableMtdMonths().map((option) => (\n                    <option key={option.value} value={option.value}>{option.label}</option>\n                  ))}\n                </select>\n              </label>\n            )}\n          </div>''',
)

replace_once(
    "wrangler.toml",
    'CMS_MCP_URL = "https://cms.mcp.siliconii.com/mcp/"\n',
    'CMS_MCP_URL = "https://cms.mcp.siliconii.com/mcp/"\nCMS_GATEWAY_URL = "https://stylekorean-cms-gateway.stylekorean.workers.dev"\n',
)
replace_once(
    "worker-configuration.d.ts",
    '\tCMS_MCP_URL: "https://cms.mcp.siliconii.com/mcp/";\n',
    '\tCMS_MCP_URL: "https://cms.mcp.siliconii.com/mcp/";\n\tCMS_GATEWAY_URL: "https://stylekorean-cms-gateway.stylekorean.workers.dev";\n',
)

css = Path("app/globals.css")
css_text = css.read_text()
css_marker = "/* CMS MTD month selector */"
if css_marker not in css_text:
    css.write_text(css_text + '''\n\n/* CMS MTD month selector */\n.kpi-period-controls { display: flex; align-items: center; justify-content: flex-end; gap: 0.65rem; flex-wrap: wrap; }\n.mtd-month-select { display: inline-flex; align-items: center; gap: 0.45rem; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }\n.mtd-month-select select { min-height: 2.25rem; border: 1px solid var(--line); border-radius: 0.55rem; padding: 0.35rem 2rem 0.35rem 0.65rem; background: var(--panel); color: var(--text); font: inherit; }\n''')
