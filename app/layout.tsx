import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
<<<<<<< HEAD
=======
import { ProductionHealth } from "./production-health";
import { StyleSwitcher } from "./style-switcher";
>>>>>>> 469241b300fe0aacf2c1ca2f59e316291ea5b49b

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
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
<<<<<<< HEAD
=======
        <StyleSwitcher />
        <ProductionHealth />
>>>>>>> 469241b300fe0aacf2c1ca2f59e316291ea5b49b
        {children}
      </body>
    </html>
  );
}
