import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 flex-1">
        {typeof title === "string" ? (
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
            {title}
          </h1>
        ) : (
          <div className="text-2xl font-semibold tracking-tight text-zinc-900">
            {title}
          </div>
        )}
        {description ? (
          <p className="mt-1 max-w-2xl text-sm text-zinc-600">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
