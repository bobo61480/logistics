"use client";

import Home from "../page";
import styles from "../style-variants.module.css";

export default function FulfillmentStyleDashboardPage() {
  return (
    <div className={`${styles.variantPage} ${styles.fulfillment}`}>
      <Home />
    </div>
  );
}
