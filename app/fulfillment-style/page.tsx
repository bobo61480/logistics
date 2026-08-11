"use client";

import Home from "../page";
import styles from "../style-variants.module.css";

function VariantNav() {
  return (
    <nav className={styles.variantNav} aria-label="Dashboard style variants">
      <a href="/">Original</a>
      <a href="/light">Light Dashboard</a>
      <a href="/fulfillment-style">Fulfillment Style</a>
    </nav>
  );
}

export default function FulfillmentStyleDashboardPage() {
  return (
    <div className={`${styles.variantPage} ${styles.fulfillment}`}>
      <VariantNav />
      <Home />
    </div>
  );
}
