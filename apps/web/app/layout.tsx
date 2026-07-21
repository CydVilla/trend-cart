import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "TrendCart", template: "%s · TrendCart" },
  description:
    "Ask a disclosed Bluesky bot for one relevant Amazon recommendation by product, budget, and use.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-zinc-50 text-zinc-900 antialiased">{children}</body>
    </html>
  );
}
