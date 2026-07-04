"use client";

import { track } from "@vercel/analytics";
import type { ReactNode } from "react";

const DEFAULT_TALLY_FORM_ID = "1AxeG1";

export function TallyFeedbackButton({
  source,
  className,
  children
}: {
  source: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <button
      className={className}
      type="button"
      data-tally-open={getTallyFormId()}
      data-tally-layout="modal"
      data-tally-width="720"
      onClick={() => track("feedback_clicked", { source })}
    >
      {children}
    </button>
  );
}

function getTallyFormId(): string {
  const configured = process.env.NEXT_PUBLIC_TALLY_FORM_ID || process.env.NEXT_PUBLIC_FEEDBACK_URL || DEFAULT_TALLY_FORM_ID;
  const match = configured.match(/(?:tally\.so\/r\/)?([A-Za-z0-9_-]+)$/);
  return match?.[1] ?? DEFAULT_TALLY_FORM_ID;
}
