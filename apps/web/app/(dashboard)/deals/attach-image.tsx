"use client";

import { useActionState, useRef, useState, startTransition } from "react";
import { attachDealImage, type AttachImageState } from "./actions";

/** Stay under Bluesky's 976 KB blob cap with room for multipart overhead. */
const TARGET_BYTES = 900_000;
const MAX_EDGE = 2000;

/**
 * Re-encode in the browser so any screenshot or photo fits Bluesky's cap: a
 * Retina screenshot is routinely several MB as PNG. Shrinks quality first,
 * then dimensions, until it fits.
 */
async function shrink(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  let scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) break;
    // JPEG has no transparency; flatten onto white, not black.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    for (const quality of [0.9, 0.8, 0.7]) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.size <= TARGET_BYTES) return { blob, width, height };
    }
    scale *= 0.8;
  }
  throw new Error("Couldn't shrink that image enough.");
}

export function AttachImage({ dealId }: { dealId: string }) {
  const [state, action, pending] = useActionState<AttachImageState, FormData>(attachDealImage, null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const busy = pending || preparing;

  async function onPick(file: File | undefined): Promise<void> {
    if (!file) return;
    setLocalError(null);
    setPreparing(true);
    try {
      const { blob, width, height } = await shrink(file);
      const formData = new FormData();
      formData.set("id", dealId);
      formData.set("image", new File([blob], "image.jpg", { type: "image/jpeg" }));
      formData.set("width", String(width));
      formData.set("height", String(height));
      startTransition(() => action(formData));
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Couldn't read that image.");
    } finally {
      setPreparing(false);
      if (input.current) input.current.value = "";
    }
  }

  const message = localError ?? state?.message ?? null;
  const good = !localError && state?.ok;
  return (
    <div className="mt-1">
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        aria-label="Image to add to this post"
        onChange={(event) => void onPick(event.target.files?.[0])}
      />
      <button
        type="button"
        disabled={busy}
        aria-busy={busy}
        onClick={() => input.current?.click()}
        className={`text-xs text-blue-600 underline ${busy ? "cursor-wait opacity-70" : ""}`}
      >
        {busy ? "adding image…" : good ? "replace image" : "add image"}
      </button>
      {message && (
        <div role="status" className={`mt-0.5 max-w-[14rem] text-xs ${good ? "text-green-700" : "text-red-600"}`}>
          {message}
        </div>
      )}
    </div>
  );
}
