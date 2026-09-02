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
  const dragDepth = useRef(0);

  function resetDrag() {
    dragDepth.current = 0;
    setDragging(false);
  }

  function onDragEnter(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
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
  }

  async function handleFiles(list: FileList | null) {
    const file = list?.[0];
    if (!file || disabled) return;
    if (!acceptMatches(file, accept)) return;
    await onFile(file);
  }

  return (
    <div
      className={`relative rounded-lg border-2 border-dashed px-4 py-5 transition ${
        dragging
          ? "border-zinc-900 bg-zinc-100"
          : "border-zinc-300 bg-zinc-50 hover:border-zinc-400 hover:bg-zinc-100/80"
      } ${disabled ? "opacity-60" : ""} ${className}`}
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-zinc-900">{title}</div>
          <p className="mt-0.5 text-sm text-zinc-600">{hint}</p>
          {dragging ? (
            <p className="mt-1 text-sm font-medium text-zinc-900">
              Solte o arquivo aqui
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="btn-primary shrink-0"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          Escolher arquivo
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        disabled={disabled}
        onChange={(e) => {
          void handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {children}
    </div>
  );
}
