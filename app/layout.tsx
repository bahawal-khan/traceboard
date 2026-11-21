import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { headers } from "next/headers";
import { connection } from "next/server";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeScript } from "@/components/theme-script";
import { TooltipProvider } from "@/components/ui/tooltip";
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
  // The theme script is inline, so it needs the same per-request nonce the CSP allows (set in proxy.ts).
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    // suppressHydrationWarning: the inline theme script sets the `dark` class and color-scheme on <html> before React hydrates.
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        {/* Rendered here, by a Server Component, so React never client-renders a <script> (that is what warns in dev). */}
        <ThemeScript nonce={nonce} />
      </head>
      <body className="min-h-full flex flex-col">
        <ThemeProvider>
          <ClerkProvider dynamic>
            <TooltipProvider>{children}</TooltipProvider>
          </ClerkProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
