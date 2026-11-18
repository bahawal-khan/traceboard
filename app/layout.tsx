import type { Metadata } from "next";
import { connection } from "next/server";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "TraceBoard",
  description: "Observability and trustworthy evaluation for LLM apps and agents.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Dynamic rendering is required so Next can apply the per-request CSP nonce
  // set in proxy.ts. Without it, prerendered scripts have no nonce and are blocked.
  await connection();
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
