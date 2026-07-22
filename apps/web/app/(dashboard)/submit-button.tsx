"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

/**
 * Submit button that reflects the enclosing form's server-action status:
 * shows an inline spinner and disables itself while the action is running, so
 * the operator gets feedback that a click is in progress and can't double-fire
 * it. Must be rendered inside the <form> whose action it submits.
 */
export function SubmitButton({
  children,
  className = "",
  pendingLabel,
  title,
  formAction,
}: {
  children: ReactNode;
  className?: string;
  /** Optional label shown while pending (defaults to the normal children). */
  pendingLabel?: string;
  title?: string;
  /** Per-button server action, for forms whose buttons submit to different
   *  actions (all sharing the form's inputs). */
  formAction?: (formData: FormData) => void | Promise<void>;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      title={title}
      formAction={formAction}
      className={`inline-flex items-center justify-center gap-1.5 ${
        pending ? "cursor-wait opacity-70" : ""
      } ${className}`}
    >
      {pending && (
        <span
          className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
      )}
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}
