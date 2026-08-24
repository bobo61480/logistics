import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
<<<<<<< HEAD
<<<<<<< HEAD
=======
import { ProductionHealth } from "./production-health";
import { StyleSwitcher } from "./style-switcher";
>>>>>>> 469241b300fe0aacf2c1ca2f59e316291ea5b49b
=======
import { ProductionHealth } from "./production-health";
import { StyleSwitcher } from "./style-switcher";
import { THEME_BOOT_SCRIPT } from "./theme";
>>>>>>> 3073244f36fcf87c014806c9f3289c04cd8fd481

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "StyleKorean Logistics Planner",
  description:
    "Live inbound and outbound shipment planning, status tracking, document access, and logistics KPIs for StyleKorean.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        {/* Applies a stored dark-theme preference before first paint so the
            page doesn't flash light-then-dark on load. Static export has no
            server to read this from, so it must run client-side, this early. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
<<<<<<< HEAD
<<<<<<< HEAD
=======
        <StyleSwitcher />
        <ProductionHealth />
>>>>>>> 469241b300fe0aacf2c1ca2f59e316291ea5b49b
=======
        <StyleSwitcher />
        <ProductionHealth />
>>>>>>> 3073244f36fcf87c014806c9f3289c04cd8fd481
        {children}
      </body>
    </html>
  );
}
