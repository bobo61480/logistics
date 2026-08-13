import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("live dashboard style variants", () => {
  test.each([
    ["app/light/page.tsx", "styles.light"],
    ["app/fulfillment-style/page.tsx", "styles.fulfillment"],
  ])("%s reuses the canonical live dashboard without duplicating navigation", (file, themeClass) => {
    expect(fs.existsSync(path.join(root, file))).toBe(true);
    const source = read(file);
    expect(source).toContain('import Home from "../page"');
    expect(source).toContain('import styles from "../style-variants.module.css"');
    expect(source).toContain(themeClass);
    expect(source).toContain("<Home />");
    expect(source).not.toContain("function VariantNav");
  });

  test("root layout exposes the same five-way style switcher on every route", () => {
    const layout = read("app/layout.tsx");
    const switcher = read("app/style-switcher.tsx");
    expect(layout).toContain('import { StyleSwitcher } from "./style-switcher"');
    expect(layout).toContain("<StyleSwitcher />");
    expect(switcher).toContain('{ href: "/", label: "Original" }');
    expect(switcher).toContain('{ href: "/light-skin", label: "Light Skin" }');
    expect(switcher).toContain('{ href: "/light", label: "Light Control Tower" }');
    expect(switcher).toContain('{ href: "/light-full", label: "Light Full" }');
    expect(switcher).toContain('{ href: "/fulfillment-style", label: "Fulfillment" }');
    expect(switcher).toContain("usePathname");
    expect(switcher).toContain("aria-current={active ? \"page\" : undefined}");
  });

  test("variant CSS places TK after the outbound trucking board", () => {
    const css = read("app/style-variants.module.css");
    expect(css).toContain("display: contents");
    expect(css).toContain(":global(.outbound-panel)");
    expect(css).toContain(":global(.fulfillment-tk-panel)");
    expect(css).toContain(":global(.outbound-parcel-panel)");
    expect(css).toMatch(/outbound-panel\)[^{]*\{[^}]*order:\s*12/);
    expect(css).toMatch(/fulfillment-tk-panel\)[^{]*\{[^}]*order:\s*13/);
    expect(css).toMatch(/outbound-parcel-panel\)[^{]*\{[^}]*order:\s*14/);
  });

  test("fulfillment money fields render as USD with a dollar sign", () => {
    const source = read("app/FulfillmentTkOrders.tsx");
    expect(source).toContain("function money");
    expect(source).toContain('style: "currency"');
    expect(source).toContain('currency: "USD"');
  });

  test("canonical fulfillment card carries the dark source treatment", () => {
    const css = read("app/fulfillment-tk-orders.module.css");
    expect(css).toContain("--tk-bg");
    expect(css).toContain("--tk-surface");
    expect(css).toContain("--tk-border");
    expect(css).toContain("--tk-amber");
    expect(css).toContain(".methodPill");
    expect(css).toContain(".badge");
  });

  test("canonical fulfillment card receives variant placement and keeps its mobile method filter", () => {
    const source = read("app/FulfillmentTkOrders.tsx");
    const css = read("app/fulfillment-tk-orders.module.css");
    expect(source).toContain("fulfillment-tk-panel");
    expect(source).toContain("fulfillment-finished-row");
    expect(source).toContain("30 * 60 * 1000");
    expect(css).not.toMatch(/\.methodPill\s*\{[^}]*display:\s*none/);
  });

  test("inbound small parcels derive carrier from tracking signature before section heading", () => {
    const source = read("app/page.tsx");
    expect(source).toContain("function carrierFromTrackingNumber");
    expect(source).toContain('/^1Z[A-Z0-9]{10,}$/');
    expect(source).toContain("const trackingCarrier = carrierFromTrackingNumber(trackingNumber);");
    expect(source).toContain("const resolvedCarrier = trackingCarrier || currentCarrier;");
    expect(source).toContain("carrier: resolvedCarrier");
    expect(source).toContain("shippingMethod: resolvedCarrier");
  });

  test("outbound parcel cards use the customer while tracking is pending", () => {
    const source = read("app/page.tsx");
    expect(source).toContain('tracking || item.customer || item.title || "Customer pending"');
    expect(source).not.toContain('tracking || "Tracking pending"');
  });

  test("outbound schedule consumes hourly auto-tracking status markers", () => {
    const page = read("app/page.tsx");
    const tracker = read("google-apps-script/InventorySync.gs");
    expect(page).toContain("const autoTrackedStatus");
    expect(tracker).toContain("function trackOutboundShipmentStatus_");
    expect(tracker).toContain('workbook.getSheetByName("Stylekorean")');
    expect(tracker).toContain("outboundTrackingCandidate_");
    expect(tracker).toContain("lookupParcelTrackingUpdate_");
  });

  test("SM Line container links open the readable cargo tracking page", () => {
    const source = read("app/page.tsx");
    expect(source).toContain('return "https://esvc.smlines.com/smline/CUP_HOM_3301.do?sessLocale=en";');
    expect(source).not.toContain("CUP_HOM_3301GS.do?_search=false");
  });

  test("both approved visual themes are present", () => {
    const css = read("app/style-variants.module.css");
    expect(css).toContain("--variant-mint");
    expect(css).toContain("--lookup-green");
    expect(css).toContain("#e9f8ef");
    expect(css).toContain("#138a55");
  });
});
