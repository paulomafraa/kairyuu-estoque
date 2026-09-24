import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/env";

export default function SetupPage() {
  if (isSupabaseConfigured()) {
    redirect("/login");
  }

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col justify-center px-4 py-16">
      <p className="text-sm text-zinc-600">Aplicativo indisponível no momento.</p>
    </main>
  );
}
