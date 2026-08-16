"use client";

import Home from "../page";
import styles from "../style-variants.module.css";

export default function LightSkinDashboardPage() {
  return (
    <div className={`${styles.variantPage} ${styles.lightSkin}`}>
      <Home />
    </div>
  );
}
