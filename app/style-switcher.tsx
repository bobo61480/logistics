import styles from "./style-variants.module.css";

const platforms = [
  { href: "https://skwarehouse.dpdns.org", label: "SKWarehouse" },
  { href: "https://skwbp.dpdns.org", label: "SKControl" },
] as const;

export function StyleSwitcher() {
  return (
    <nav className={styles.variantNav} aria-label="StyleKorean platforms">
      <span className={styles.variantNavLabel}>PLATFORMS</span>
      {platforms.map((platform) => (
        <a href={platform.href} key={platform.href} target="_blank" rel="noreferrer">
          {platform.label}
        </a>
      ))}
    </nav>
  );
}
