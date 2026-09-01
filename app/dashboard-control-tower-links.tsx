"use client";

import { useEffect } from "react";

const LOGISTICS_HOST = "skwarehouse.dpdns.org";
const WAREHOUSE_HOST = "skwbp.dpdns.org";

function applyControlTowerDestinations() {
  document.querySelectorAll<HTMLElement>(".sys-badge").forEach((badge) => {
    const name = badge.querySelector<HTMLElement>(".sys-badge-name");
    const host = badge.querySelector<HTMLElement>(".sys-badge-host");
    if (!name || !host) return;

    if (name.textContent === "Logistics Control Tower") {
      if (host.textContent !== LOGISTICS_HOST) host.textContent = LOGISTICS_HOST;
      return;
    }

    if (name.textContent === "Warehouse Control Tower") {
      if (host.textContent !== WAREHOUSE_HOST) host.textContent = WAREHOUSE_HOST;
      const anchor = badge instanceof HTMLAnchorElement ? badge : badge.closest<HTMLAnchorElement>("a");
      if (anchor) {
        const target = `https://${WAREHOUSE_HOST}`;
        if (anchor.href !== `${target}/` && anchor.href !== target) anchor.href = target;
      }
    }
  });
}

export function DashboardControlTowerLinks() {
  useEffect(() => {
    applyControlTowerDestinations();

    const observer = new MutationObserver(() => applyControlTowerDestinations());
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
