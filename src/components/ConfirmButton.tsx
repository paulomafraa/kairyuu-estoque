"use client";

import { useState } from "react";

export function ConfirmButton({
  label,
  confirmLabel = "Confirmar?",
  onConfirm,
  className,
  disabled,
}: {
  label: string;
  confirmLabel?: string;
  onConfirm: () => Promise<void> | void;
  className?: string;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={disabled || busy}
      className={className}
      onClick={async () => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setBusy(true);
        try {
          await onConfirm();
        } finally {
          setBusy(false);
          setArmed(false);
        }
      }}
      onBlur={() => setArmed(false)}
    >
      {busy ? "..." : armed ? confirmLabel : label}
    </button>
  );
}
