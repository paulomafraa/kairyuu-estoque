import { redirect } from "next/navigation";
import { AppNav } from "@/components/AppNav";
import { isSupabaseConfigured } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!isSupabaseConfigured()) {
    redirect("/setup");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("name")
    .eq("id", user.id)
    .maybeSingle();

  return (
    <div className="min-h-full">
      <AppNav userName={profile?.name || user.email || undefined} />
      <main className="mx-auto w-full max-w-[1600px] px-4 py-6 lg:px-6">{children}</main>
    </div>
  );
}
