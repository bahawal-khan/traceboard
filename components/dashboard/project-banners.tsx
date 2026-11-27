import { Info } from "lucide-react";
import { QuotaBanner } from "@/components/dashboard/quota-banner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { selectNotices, type ProjectNotices } from "@/lib/dashboard/project-notices";

/**
 * The notices above every project page: the daily-quota banner and the conserve banner. Server-rendered with the page (no client
 * code, no polling), so nothing appears after load. Mounted ONLY by ProjectFrame. Renders nothing for null (unknown). Icon plus
 * words, a polite status.
 */
export function ProjectBanners({ notices }: { notices: ProjectNotices | null | undefined }) {
  const sel = selectNotices(notices);
  if (!sel.quota && !sel.conserve) return null;
  return (
    <div className="mt-4 space-y-3" data-slot="project-banners">
      {sel.quota && notices ? <QuotaBanner used={notices.eventsToday} limit={notices.eventsLimit} /> : null}
      {sel.conserve ? (
        <Alert role="status" data-notice="conserve">
          <Info className="text-status-warning" aria-hidden />
          <AlertTitle>{sel.conserve.title}</AlertTitle>
          <AlertDescription>{sel.conserve.body}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
