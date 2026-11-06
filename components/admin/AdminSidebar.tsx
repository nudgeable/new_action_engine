"use client";

import React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { clearAdminBatchSelection } from "@/components/admin/AdminContext";
import {
  LayoutDashboard,
  Settings2,
  ChevronDown,
  ChevronRight,
  LogOut,
  ArrowLeft,
} from "lucide-react";

interface NavItem {
  id: string;
  label: string;
  icon: React.ElementType;
  href?: string;
  children?: { id: string; label: string; href: string }[];
}

const navItems: NavItem[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    href: "/admin",
  },
  {
    // Every batch task (dates, participants, teams, conversations,
    // announcements, content) is a card on this one page.
    id: "control-panel",
    label: "Control Panel",
    icon: Settings2,
    href: "/admin/control-panel",
  },
];

interface AdminSidebarProps {
  displayName: string;
}

export function AdminSidebar({ displayName }: AdminSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [expandedSections, setExpandedSections] = React.useState<Set<string>>(
    new Set(["control-panel"])
  );

  const handleLogout = async () => {
    clearAdminBatchSelection();
    const supabase = createClient();
    await supabase.auth.signOut();
    router.refresh();
    router.push("/login");
  };

  const toggleSection = (id: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const isActive = (href: string) => {
    if (href === "/admin") {
      return pathname === "/admin";
    }
    return pathname.startsWith(href);
  };

  const isParentActive = (item: NavItem) => {
    if (item.href) return isActive(item.href);
    return item.children?.some((child) => isActive(child.href)) ?? false;
  };

  return (
    <aside
      className="w-64 flex flex-col h-full shrink-0 overflow-y-auto"
      style={{
        background: "var(--color-bg-dark)",
        borderRight: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      {/* ── Header ── */}
      <div
        className="p-6 flex flex-col gap-1"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}
      >
        <Link
          href="/admin"
          className="flex items-center gap-3 hover:opacity-80 transition-opacity"
        >
          <img
            src="/NudgeableBlack.png"
            alt="Nudgeable"
            style={{ height: 40, width: "auto", filter: "brightness(0) invert(1)" }}
          />
        </Link>
        <span
          className="text-xs font-semibold uppercase tracking-widest mt-2"
          style={{ color: "rgba(255,255,255,0.35)", letterSpacing: "0.18em" }}
        >
          Admin Panel
        </span>
      </div>

      {/* ── Navigation ── */}
      <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const Icon = item.icon;
          const hasChildren = item.children && item.children.length > 0;
          const isExpanded = expandedSections.has(item.id);
          const active = isParentActive(item);

          if (hasChildren) {
            return (
              <div key={item.id} className="space-y-0.5">
                <button
                  onClick={() => toggleSection(item.id)}
                  className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl transition-all text-sm font-semibold"
                  style={{
                    background: active ? "rgba(255,206,0,0.10)" : "transparent",
                    color: active ? "var(--bright-amber)" : "rgba(255,255,255,0.5)",
                  }}
                >
                  <div className="flex items-center gap-3">
                    <Icon size={16} strokeWidth={2} />
                    <span>{item.label}</span>
                  </div>
                  {isExpanded ? (
                    <ChevronDown size={14} strokeWidth={2} />
                  ) : (
                    <ChevronRight size={14} strokeWidth={2} />
                  )}
                </button>

                {isExpanded && (
                  <div
                    className="ml-6 mt-0.5 space-y-0.5 pl-3"
                    style={{ borderLeft: "1px solid rgba(255,255,255,0.08)" }}
                  >
                    {item.children!.map((child) => (
                      <Link
                        key={child.id}
                        href={child.href}
                        className="block px-3 py-2 rounded-lg text-xs font-semibold transition-all"
                        style={
                          isActive(child.href)
                            ? {
                              background: "var(--bright-amber)",
                              color: "var(--shadow-grey)",
                            }
                            : {
                              color: "rgba(255,255,255,0.45)",
                              background: "transparent",
                            }
                        }
                        onMouseEnter={(e) => {
                          if (!isActive(child.href)) {
                            (e.currentTarget as HTMLElement).style.background =
                              "rgba(255,255,255,0.06)";
                            (e.currentTarget as HTMLElement).style.color =
                              "rgba(255,255,255,0.8)";
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (!isActive(child.href)) {
                            (e.currentTarget as HTMLElement).style.background =
                              "transparent";
                            (e.currentTarget as HTMLElement).style.color =
                              "rgba(255,255,255,0.45)";
                          }
                        }}
                      >
                        {child.label}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          }

          return (
            <Link
              key={item.id}
              href={item.href!}
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all"
              style={
                active
                  ? {
                    background: "var(--bright-amber)",
                    color: "var(--shadow-grey)",
                  }
                  : {
                    color: "rgba(255,255,255,0.5)",
                    background: "transparent",
                  }
              }
              onMouseEnter={(e) => {
                if (!active) {
                  (e.currentTarget as HTMLElement).style.background =
                    "rgba(255,255,255,0.06)";
                  (e.currentTarget as HTMLElement).style.color =
                    "rgba(255,255,255,0.8)";
                }
              }}
              onMouseLeave={(e) => {
                if (!active) {
                  (e.currentTarget as HTMLElement).style.background =
                    "transparent";
                  (e.currentTarget as HTMLElement).style.color =
                    "rgba(255,255,255,0.5)";
                }
              }}
            >
              <Icon size={16} strokeWidth={2} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Back to app */}
      <Link
        href="/journey"
        className="mx-4 flex items-center justify-center gap-2 px-3 py-2.5 mb-2 rounded-xl text-sm font-semibold transition-all"
        style={{
          background: "rgba(255,206,0,0.12)",
          color: "var(--bright-amber)",
          border: "1px solid rgba(255,206,0,0.55)",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.background = "rgba(255,206,0,0.22)";
          (e.currentTarget as HTMLElement).style.borderColor = "var(--bright-amber)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = "rgba(255,206,0,0.12)";
          (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,206,0,0.55)";
        }}
      >
        <ArrowLeft size={14} strokeWidth={2} />
        Participant View
      </Link>
      {/* ── Footer ── */}
      <div
        className="p-4 space-y-3"
        style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}
      >


        {/* User info */}
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
            style={{ background: "var(--bright-amber)", color: "var(--shadow-grey)" }}
          >
            {displayName.substring(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold truncate" style={{ color: "var(--white)" }}>
              {displayName}
            </p>
            <p className="text-xs" style={{ color: "rgba(255,255,255,0.35)" }}>
              Administrator
            </p>
          </div>
        </div>

        {/* Dot decorations */}
        <div className="flex gap-2 px-1">
          <div className="w-2 h-2 rounded-full" style={{ background: "var(--bright-amber)" }} />
          <div className="w-2 h-2 rounded-full" style={{ background: "var(--dodger-blue)" }} />
          <div className="w-2 h-2 rounded-full" style={{ background: "rgba(255,255,255,0.15)" }} />
        </div>

        {/* Logout */}
        <button
          onClick={handleLogout}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all"
          style={{
            background: "rgba(255,255,255,0.06)",
            color: "rgba(255,255,255,0.45)",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = "rgba(237,69,81,0.15)";
            (e.currentTarget as HTMLElement).style.color = "#ED4551";
            (e.currentTarget as HTMLElement).style.borderColor = "rgba(237,69,81,0.3)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.06)";
            (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.45)";
            (e.currentTarget as HTMLElement).style.borderColor = "rgba(255,255,255,0.08)";
          }}
        >
          <LogOut size={14} />
          Logout
        </button>
      </div>
    </aside>
  );
}
