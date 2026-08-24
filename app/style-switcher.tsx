<<<<<<< HEAD
"use client";

import { usePathname } from "next/navigation";
import styles from "./style-variants.module.css";

const options = [
  { href: "/", label: "Original" },
  { href: "/light-skin", label: "Light Skin" },
  { href: "/light", label: "Light Control Tower" },
  { href: "/light-full", label: "Light Full" },
  { href: "/fulfillment-style", label: "Fulfillment" },
] as const;

export function StyleSwitcher() {
  const pathname = usePathname();

  return (
    <nav className={styles.variantNav} aria-label="Dashboard appearance">
      <span className={styles.variantNavLabel}>APPEARANCE</span>
      {options.map((option) => {
        const active = pathname === option.href;
        return (
          <a
            aria-current={active ? "page" : undefined}
            href={option.href}
            key={option.href}
            className={active ? styles.variantActive : undefined}
          >
            {option.label}
          </a>
        );
      })}
=======
import styles from "./style-variants.module.css";

const platforms = [
  { href: "https://stylekorean.dpdns.org", label: "StyleKorean", key: "stylekorean" },
  { href: "https://skwarehouse.dpdns.org", label: "SKWarehouse", key: "skwarehouse" },
  { href: "https://skwbp.dpdns.org", label: "SKControl", key: "skwbp" },
] as const;

export function StyleSwitcher() {
  return (
    <nav className={styles.variantNav} aria-label="StyleKorean platforms">
      <span className={styles.variantNavLabel}>PLATFORMS</span>
      {platforms.map((platform) =>
        platform.key === "stylekorean" ? (
          <span className={styles.variantNavCurrent} key={platform.key} aria-current="page">
            {platform.label}
          </span>
        ) : (
          <a href={platform.href} key={platform.key} target="_blank" rel="noreferrer">
            {platform.label}
          </a>
        ),
      )}
>>>>>>> 3073244f36fcf87c014806c9f3289c04cd8fd481
    </nav>
  );
}
