"use client";
import type { ReactNode } from "react";
import { SiteNav } from "./SiteNav";

/** En-tête commun des pages hors partie : logo, titre, actions, navigation. */
export function PageHeader({ title, active, children }: { title: string; active?: Parameters<typeof SiteNav>[0]["active"]; children?: ReactNode }) {
  return (
    <>
      <header className="mx-auto flex h-13 max-w-[1400px] items-center gap-3 px-3 lg:px-6">
        <a href="/play" className="font-display text-lg font-bold tracking-tight">Chess<span className="text-neon">Arena</span></a>
        <span className="truncate text-sm text-muted">· {title}</span>
        <div className="ml-auto flex items-center gap-1.5">{children}</div>
      </header>
      <SiteNav active={active} />
    </>
  );
}
