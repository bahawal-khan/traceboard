"use client";

import { UserButton } from "@clerk/nextjs";
import { AfterMount } from "@/components/clerk/after-mount";

/**
 * The avatar menu. Clerk's UserButton is mounted only after hydration (see AfterMount for why); until then, and in the
 * server HTML, a muted circle of the same size is shown, so nothing shifts when it appears.
 * The avatar is 32 px (2 rem, set explicitly so the placeholder can match it) inside a 44 px tap target on small screens.
 */
export function AccountMenu() {
  return (
    <div className="flex size-11 items-center justify-center sm:size-9">
      <AfterMount placeholder={<span aria-hidden className="block size-8 rounded-full bg-muted" />}>
        <UserButton appearance={{ elements: { avatarBox: { width: "2rem", height: "2rem" } } }} />
      </AfterMount>
    </div>
  );
}
