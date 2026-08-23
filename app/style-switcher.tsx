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
    </nav>
  );
}
