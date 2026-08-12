"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./production-health.module.css";

type ProductionHealthPayload = {
  ok?: boolean;
  version?: string;
  databaseConfigured?: boolean;
  statusWriteConfigured?: boolean;
  statusWriteMode?: string;
  checkedAt?: string;
};

type HealthState = {
  payload: ProductionHealthPayload | null;
  error: boolean;
};

const HEALTH_ENDPOINT = "/api/logistics/health";
const REFRESH_MS = 5 * 60 * 1000;

export function ProductionHealth() {
  const [state, setState] = useState<HealthState>({ payload: null, error: false });

  const refresh = useCallback(async () => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(`${HEALTH_ENDPOINT}?ui=${Date.now()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as ProductionHealthPayload;
      if (payload.ok !== true) throw new Error("Worker health check failed");
      setState({ payload, error: false });
    } catch {
      setState((current) => ({ payload: current.payload, error: true }));
    } finally {
      window.clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const apiStatus = state.error ? "UNAVAILABLE" : state.payload ? "ONLINE" : "CHECKING";
  const writeStatus = state.payload
    ? state.payload.statusWriteConfigured
      ? "READY"
      : "UNAVAILABLE"
    : state.error
      ? "UNKNOWN"
      : "CHECKING";
  const databaseStatus = state.payload
    ? state.payload.databaseConfigured
      ? "CONNECTED"
      : "OPTIONAL / UNBOUND"
    : "CHECKING";

  return (
    <section className={styles.strip} aria-label="Production health">
      <span className={styles.heading}>SYSTEM</span>
      <span className={styles.item}>
        API <strong data-state={apiStatus}>{apiStatus}</strong>
      </span>
      <span className={styles.item}>
        WRITE PROXY <strong data-state={writeStatus}>{writeStatus}</strong>
      </span>
      <span className={styles.item}>
        DATABASE <strong data-state={databaseStatus}>{databaseStatus}</strong>
      </span>
      {state.payload?.version && <span className={styles.version}>{state.payload.version}</span>}
    </section>
  );
}
