import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { AdminShell } from "@/components/admin/AdminContext";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, full_name, company_id")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "admin" && profile?.role !== "superadmin") {
    redirect("/");
  }

  const displayName = profile?.full_name || user.email?.split("@")[0] || "Admin";

  const { data: companies } = await supabase
    .from("companies")
    .select("id, name, slug")
    .order("name");

  return (
    <div className="h-screen flex overflow-hidden" style={{ background: "#EEF0F5" }}>
      <AdminSidebar displayName={displayName} />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        <main className="flex-1 p-4 sm:p-6 lg:p-8 overflow-y-auto relative">
          <AdminShell
            companies={companies ?? []}
            role={profile?.role ?? "user"}
            companyId={profile?.company_id ?? null}
            userId={user.id}
          >
            {children}
          </AdminShell>
        </main>
      </div>
    </div>
  );
}
