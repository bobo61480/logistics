"use client";

import Home from "../page";
import styles from "../style-variants.module.css";

export default function LightDashboardPage() {
  return (
    <div className={`${styles.variantPage} ${styles.light}`}>
      <Home />
    </div>
  );
}
