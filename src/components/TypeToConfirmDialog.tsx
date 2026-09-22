"use client";

import { useEffect, useState } from "react";

export const CONFIRM_WORD = "CONFIRMAR";

export function TypeToConfirmDialog({
  open,
  title,
  warning,
  confirmLabel = "Excluir de vez",
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  warning: string;
  confirmLabel?: string;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  if (!open) return null;

  const ok = typed.trim() === CONFIRM_WORD;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="type-confirm-title"
        className="w-full max-w-md rounded-lg border border-red-200 bg-white p-4 shadow-xl"
      >
        <h2 id="type-confirm-title" className="text-base font-semibold text-red-900">
          {title}
        </h2>
        <p className="mt-2 text-sm text-zinc-700 whitespace-pre-line">{warning}</p>
        <label className="mt-4 block text-sm">
          <span className="mb-1 block font-medium text-zinc-800">
            Digite {CONFIRM_WORD} para concluir
          </span>
          <input
            className="field"
            autoFocus
            autoComplete="off"
            value={typed}
            disabled={busy}
            onChange={(e) => setTyped(e.target.value.toUpperCase())}
            placeholder={CONFIRM_WORD}
          />
        </label>
        {error ? (
          <p className="mt-2 text-sm text-red-700">{error}</p>
        ) : null}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={onCancel}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50"
            disabled={!ok || busy}
            onClick={() => void onConfirm()}
          >
            {busy ? "Aguarde..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
