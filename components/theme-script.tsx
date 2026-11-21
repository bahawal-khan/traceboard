import { THEME_SCRIPT } from "@/lib/theme";

/**
 * The pre-paint theme script, rendered by the ROOT LAYOUT (a Server Component) inside <head>, with the request's CSP nonce.
 *
 * Deliberately NOT a Client Component and with no `"use client"`: a <script> rendered from a Client Component makes React 19
 * warn in development ("Encountered a script tag while rendering React component") whenever React client-renders it, which
 * is exactly what next-themes did. See the Next.js guide "Preventing flash before hydration" (Themes).
 */
export function ThemeScript({ nonce }: { nonce?: string }) {
  return <script nonce={nonce}>{THEME_SCRIPT}</script>;
}
