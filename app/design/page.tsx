import { notFound } from "next/navigation";
import { DesignGallery } from "./gallery";

export const metadata = { title: "Chart kit", robots: { index: false, follow: false } };

/** Development-only gallery of the shared dashboard components. A production build answers 404. */
export default function DesignPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <DesignGallery />;
}
