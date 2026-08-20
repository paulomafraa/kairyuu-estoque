export function Badge({
  children,
  tone = "neutral",
  onClick,
  title,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad" | "info";
  onClick?: () => void;
  title?: string;
}) {
  const tones = {
    neutral: "bg-zinc-100 text-zinc-700",
    good: "bg-emerald-50 text-emerald-800",
    warn: "bg-amber-50 text-amber-900",
    bad: "bg-red-50 text-red-800",
    info: "bg-sky-50 text-sky-900",
  };

  const className = `inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${tones[tone]}${
    onClick
      ? " cursor-pointer transition hover:ring-2 hover:ring-zinc-300 hover:ring-offset-1"
      : ""
  }`;

  if (onClick) {
    return (
      <button
        type="button"
        className={className}
        onClick={onClick}
        title={title || "Clique para inverter"}
      >
        {children}
      </button>
    );
  }

  return (
    <span className={className} title={title}>
      {children}
    </span>
  );
}
