import { quotaBanner, type QuotaBannerText } from "@/lib/dashboard/quota-banner";
import { FLUSH_HINT_MS } from "@/lib/quotas";

/**
 * The notices every project page shows (pure; no I/O). Input is what `readProjectStatus` returned, or null when that read failed
 * or the project is not readable: null means UNKNOWN and shows nothing (never a guess, never zero). Each kind appears at most
 * once. ProjectFrame is the only place that renders them.
 */
export interface ProjectNotices {
  eventsToday: number;
  eventsLimit: number;
  conserve: boolean;
}

export interface ConserveBannerText {
  title: string;
  body: string;
}

/**
 * What conserve mode really does today (checked against the code, P3.10b step 0): the ingest response tells the Python SDK to
 * flush every FLUSH_HINT_MS.conserve (60 s) instead of every 1 to 15 s. NOTHING is refused or dropped, ingest, the quota and
 * every page work as before. The hint reaches the SDK only: an OpenTelemetry exporter keeps its own schedule. So the text says
 * "slower", "SDK" and "batches", and does not say events are lost, paused, or limited. The number comes from the constant.
 */
export function conserveBanner(): ConserveBannerText {
  const seconds = Math.round(FLUSH_HINT_MS.conserve / 1000);
  return {
    title: "Data is arriving more slowly",
    body: `This deployment is asking the SDK to send events in larger batches, about once every ${seconds} seconds. New events are still accepted and stored; they can take a minute or more to show up here.`,
  };
}

export interface SelectedNotices {
  quota: QuotaBannerText | null;
  conserve: ConserveBannerText | null;
}

export function selectNotices(n: ProjectNotices | null | undefined): SelectedNotices {
  if (!n) return { quota: null, conserve: null };
  return { quota: quotaBanner(n.eventsToday, n.eventsLimit), conserve: n.conserve === true ? conserveBanner() : null };
}
