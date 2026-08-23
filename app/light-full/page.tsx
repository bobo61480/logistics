"use client";

import Home from "../page";
import styles from "../style-variants.module.css";

export default function LightFullDashboardPage() {
  return (
    <div className={`${styles.variantPage} ${styles.lightFull}`}>
      <header className={styles.lightFullHeader}>
        <div>
          <span>STYLEKOREAN · OPERATIONS</span>
          <strong>Control Tower</strong>
        </div>
        <p>Inbound · Outbound · Inventory · Fulfillment · Exceptions</p>
      </header>
      <Home />
    </div>
  );
}
