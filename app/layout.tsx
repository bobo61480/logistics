import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ProductionHealth } from "./production-health";
import { StyleSwitcher } from "./style-switcher";
import { THEME_BOOT_SCRIPT } from "./theme";

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
        <StyleSwitcher />
        <ProductionHealth />
        {children}
      </body>
    </html>
  );
}
