import { redirect } from "next/navigation";
import { CapacityNotice } from "@/components/dashboard/capacity-notice";
import { ConnectionError } from "@/components/connection-error";
import { isConnectionError } from "@/lib/errors/connection";
import { ensureSignedInUserSlot } from "@/lib/repo/users";

/** First dashboard load registers the user and enforces the free-deployment user cap. */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // An error.tsx in this segment cannot catch errors thrown by this layout, so handle the transient case here.
  let status;
  try {
    status = await ensureSignedInUserSlot();
  } catch (err) {
    if (isConnectionError(err)) return <ConnectionError />;
    throw err;
  }
  if (status === "signed_out") redirect("/sign-in");

  if (status === "full" || status === "paused") return <CapacityNotice status={status} />;

  return children;
}
