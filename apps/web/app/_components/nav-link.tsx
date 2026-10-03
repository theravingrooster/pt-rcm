"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = href === "/"
    ? pathname === "/"
    : pathname === href || pathname.startsWith(`${href}/`)
      || (href === "/queues" && (pathname === "/encounters" || pathname.startsWith("/encounters/")))
      || (href === "/reports" && pathname === "/metrics");

  return <Link href={href} aria-current={active ? "page" : undefined}>{children}</Link>;
}
