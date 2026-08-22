import styles from "./style-variants.module.css";

const links = [
  { href: "https://skwarehouse.dpdns.org", label: "SKWarehouse" },
  { href: "https://skwbp.dpdns.org", label: "SKControl" },
] as const;

export function AppLinks() {
  return (
    <nav className={styles.variantNav} aria-label="StyleKorean applications">
      <span className={styles.variantNavLabel}>APPS</span>
      {links.map((link) => (
        <a href={link.href} key={link.href} target="_blank" rel="noreferrer">
          {link.label}
        </a>
      ))}
    </nav>
  );
}
