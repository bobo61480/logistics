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
    </nav>
  );
}
