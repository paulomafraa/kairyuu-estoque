import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/env";

export default function HomePage() {
  if (!isSupabaseConfigured()) {
    redirect("/setup");
  }
  redirect("/estoque");
}
