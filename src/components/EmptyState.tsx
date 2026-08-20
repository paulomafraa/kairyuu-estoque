export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 px-4 py-10 text-center">
      <p className="font-medium text-zinc-800">{title}</p>
      {hint ? <p className="mt-1 text-sm text-zinc-500">{hint}</p> : null}
    </div>
  );
}
