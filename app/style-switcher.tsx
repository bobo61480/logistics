"use client";

import { usePathname } from "next/navigation";
import styles from "./style-variants.module.css";

const options = [
  { href: "/", label: "Original" },
  { href: "/light", label: "Light" },
  { href: "/fulfillment-style", label: "Fulfillment" },
] as const;

export function StyleSwitcher() {
  const pathname = usePathname();

  return (
    <nav className={styles.variantNav} aria-label="Dashboard appearance">
      {options.map((option) => {
        const active = pathname === option.href;
        return (
          <a
            aria-current={active ? "page" : undefined}
            href={option.href}
            key={option.href}
            style={active ? { fontWeight: 900, boxShadow: "inset 0 -2px 0 currentColor" } : undefined}
          >
            {option.label}
          </a>
        );
      })}
    </nav>
  );
}
