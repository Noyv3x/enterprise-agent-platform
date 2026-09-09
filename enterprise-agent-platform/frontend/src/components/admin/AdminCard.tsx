import type { ReactNode } from "react";
import { Section } from "../ui/fieldwork";

export function AdminCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className}><Section>{children}</Section></div>;
}
