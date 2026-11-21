"use client";

import { useSyncExternalStore, type ReactNode } from "react";

const subscribeNothing = () => () => {};

/**
 * Renders `children` only in the browser, after hydration; the server HTML and the first client render both show
 * `placeholder`, so they always match.
 *
 * WHY (found in the installed Clerk packages, @clerk/react 6.19): Clerk's UI components (UserButton, SignIn, SignUp)
 * render `{clerk.loaded && <ClerkHostRenderer/>}`, i.e. an extra <div data-clerk-component="..."> as soon as clerk-js has
 * loaded. The server never has a loaded clerk-js, but in the browser clerk-js is an external, cached script that can finish
 * loading BEFORE React hydrates the component (slow hydration, as in `next dev`, makes that likely). The first client render
 * then contains the div that the server HTML lacks: "Hydration failed", React discards the server HTML and client-renders the
 * tree, which in turn makes React re-create every <script> and warn "Encountered a script tag while rendering React component".
 * Giving the placeholder the same size as the real thing avoids a layout shift.
 *
 * `useSyncExternalStore` with a server snapshot of `false` is the hydration-safe way to say "not mounted yet": during
 * hydration React uses the server snapshot, then re-renders with the client one.
 */
export function AfterMount({ children, placeholder }: { children: ReactNode; placeholder: ReactNode }) {
  const mounted = useSyncExternalStore(subscribeNothing, () => true, () => false);
  return <>{mounted ? children : placeholder}</>;
}
