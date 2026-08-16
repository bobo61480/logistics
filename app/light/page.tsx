"use client";

import Home from "../page";
import styles from "../style-variants.module.css";

export default function LightDashboardPage() {
  return (
    <div className={`${styles.variantPage} ${styles.light} ${styles.controlTowerShell}`}>
      <aside className={styles.controlTowerRail}>
        <div className={styles.controlTowerBrand}>
          <strong>SK</strong>
          <span>CONTROL TOWER</span>
          <small>LIGHT OPERATIONS</small>
        </div>
        <nav aria-label="Control Tower sections">
          <a href="#kpi-heading">Overview</a>
          <a href="#inbound-schedule-heading">Inbound</a>
          <a href="#outbound-schedule-heading">Outbound</a>
          <a href="#fulfillment-tk-heading">Fulfillment</a>
        </nav>
        <div className={styles.controlTowerRailStatus}>
          <i aria-hidden="true" />
          <span>LIVE OPERATIONS</span>
        </div>
      </aside>
      <div className={styles.controlTowerMain}>
        <Home />
      </div>
    </div>
  );
}
