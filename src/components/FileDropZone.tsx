"use client";

import { DragEvent, ReactNode, useRef, useState } from "react";

type Props = {
  accept?: string;
  disabled?: boolean;
  onFile: (file: File) => void | Promise<void>;
  title: string;
  hint: string;
  children?: ReactNode;
  className?: string;
};

function acceptMatches(file: File, accept?: string): boolean {
  if (!accept) return true;
  const parts = accept.split(",").map((p) => p.trim().toLowerCase());
  const name = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();
  return parts.some((p) => {
    if (p.startsWith(".")) return name.endsWith(p);
    if (p.endsWith("/*")) return type.startsWith(p.slice(0, -1));
    return type === p || name.endsWith(p.replace(/^\./, "."));
  });
}

function dragHasFile(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types || []).includes("Files");
}

export function FileDropZone({
  accept,
  disabled,
  onFile,
  title,
  hint,
  children,
  className = "",
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const dragDepth = useRef(0);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showNote(text: string) {
    setNote(text);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), 4000);
  }

  function resetDrag() {
    dragDepth.current = 0;
    setDragging(false);
  }

  function onDragEnter(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (disabled || working || !dragHasFile(e)) return;
    dragDepth.current += 1;
    setDragging(true);
  }

  function onDragLeave(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function onDragOver(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = disabled || working ? "none" : "copy";
  }

  async function handleFiles(list: FileList | null) {
    const file = list?.[0];
    if (!file || disabled || working) return;
    if (!acceptMatches(file, accept)) {
      showNote("Esse arquivo não entra aqui. Use o formato pedido na caixa.");
      return;
    }
    setWorking(true);
    setNote(null);
    try {
      await onFile(file);
    } catch (err) {
      showNote(err instanceof Error ? err.message : "Não deu para ler esse arquivo.");
    } finally {
      setWorking(false);
    }
  }

  const locked = disabled || working;

  return (
    <div className={className}>
      <div
        className={`rounded-xl border-2 border-dashed transition ${
          dragging
            ? "border-emerald-500 bg-emerald-50 shadow-sm ring-2 ring-emerald-200"
            : working
              ? "border-emerald-400 bg-emerald-50"
              : "border-zinc-300 bg-white hover:border-zinc-500 hover:bg-zinc-50"
        } ${locked && !working ? "opacity-60" : ""}`}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          resetDrag();
          void handleFiles(e.dataTransfer.files);
        }}
      >
        <button
          type="button"
          className="flex w-full flex-col items-center gap-3 px-4 py-6 text-center sm:flex-row sm:items-center sm:justify-between sm:text-left"
          disabled={locked}
          onClick={() => inputRef.current?.click()}
        >
          <span
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border ${
              dragging || working
                ? "border-emerald-300 bg-white text-emerald-700"
                : "border-zinc-200 bg-zinc-50 text-zinc-700"
            }`}
            aria-hidden
          >
            {working ? (
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-emerald-200 border-t-emerald-600" />
            ) : (
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M12 16V5" strokeLinecap="round" />
                <path d="M8 8.5 12 4.5 16 8.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 16.5V19a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2.5" strokeLinecap="round" />
              </svg>
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-zinc-900">
              {working ? "Lendo o arquivo…" : dragging ? "Solte para importar" : title}
            </span>
            <span className={`mt-0.5 block text-sm ${dragging ? "text-emerald-800" : "text-zinc-600"}`}>
              {working
                ? "A importação está em andamento."
                : dragging
                  ? "A caixa está pronta. Solte o arquivo."
                  : hint}
            </span>
            {note ? (
              <span className="mt-1 block text-sm font-medium text-red-700">{note}</span>
            ) : null}
          </span>
          <span
            className={`inline-flex shrink-0 items-center justify-center rounded-md px-3 py-2 text-sm font-medium ${
              dragging
                ? "bg-emerald-600 text-white"
                : "bg-zinc-900 text-white"
            }`}
          >
            {working ? "Aguarde" : dragging ? "Solte aqui" : "Escolher arquivo"}
          </span>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          disabled={locked}
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {children}
    </div>
  );
}
