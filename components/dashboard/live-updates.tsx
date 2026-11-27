"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { LiveBannerView } from "@/components/dashboard/live-banner-view";
import { bannerState, liveEnabledForPath } from "@/lib/dashboard/live-banner";
import { INITIAL_LIVE_SNAPSHOT, createLivePoller, type LivePoller, type LiveSnapshot } from "@/lib/dashboard/live-poller";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTERACTION_EVENTS = ["pointerdown", "pointermove", "keydown", "touchstart", "wheel", "scroll"] as const;

/**
 * Quiet "new events" notice for a project page (P3.9a). Mounted once per page by ProjectFrame (a layout is not an option here:
 * tests/project-pages.test.ts requires that the [id] segment has none). All behaviour is in
 * lib/dashboard/live-poller.ts; this component only wires real browser objects into it and draws LiveBannerView.
 *
 * Deliberately absent: any web storage (the cursor lives in the poller's memory only), any rendering of server-provided text.
 * The API keys page is skipped (nothing there changes with new events). The public /demo never imports this file.
 */
export function LiveUpdates({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const enabled = UUID.test(projectId) && liveEnabledForPath(pathname);
  const [snapshot, setSnapshot] = useState<LiveSnapshot>(INITIAL_LIVE_SNAPSHOT);
  const pollerRef = useRef<LivePoller | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const poller = createLivePoller({
      fetchFn: (url, init) => fetch(url, init),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (h) => window.clearTimeout(h as number),
      now: () => Date.now(),
      random: () => Math.random(),
      isVisible: () => document.visibilityState !== "hidden",
      isOnline: () => navigator.onLine !== false,
      endpoint: `/api/dashboard/projects/${encodeURIComponent(projectId)}/live`,
    });
    pollerRef.current = poller;
    const unsubscribe = poller.subscribe(() => setSnapshot(poller.getSnapshot()));
    const onInteraction = () => poller.notifyInteraction();
    const onVisibility = () => poller.notifyVisibilityChange();
    const onConnectivity = () => poller.notifyEnvironmentChange();
    for (const e of INTERACTION_EVENTS) window.addEventListener(e, onInteraction, { passive: true, capture: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onConnectivity);
    window.addEventListener("offline", onConnectivity);
    poller.start();
    return () => {
      for (const e of INTERACTION_EVENTS) window.removeEventListener(e, onInteraction, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onConnectivity);
      window.removeEventListener("offline", onConnectivity);
      unsubscribe();
      poller.stop(); // aborts the request in flight and clears the timer
      pollerRef.current = null;
      setSnapshot(INITIAL_LIVE_SNAPSHOT);
    };
  }, [enabled, projectId]);

  // The same page asked for other data (?range=, ?status=, ?cursor=) is a fresh server render: start counting from zero.
  // (Another page of the project remounts this component, which starts a new baseline.)
  const navKey = `${pathname}?${searchParams?.toString() ?? ""}`;
  const lastKey = useRef(navKey);
  useEffect(() => {
    if (lastKey.current === navKey) return;
    lastKey.current = navKey;
    pollerRef.current?.acknowledge();
  }, [navKey]);

  const refresh = useCallback(() => {
    pollerRef.current?.acknowledge();
    router.refresh();
  }, [router]);
  const resume = useCallback(() => pollerRef.current?.resume(), []);

  return <LiveBannerView state={enabled ? bannerState(snapshot) : { kind: "none" }} onRefresh={refresh} onResume={resume} />;
}
