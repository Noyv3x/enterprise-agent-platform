import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Beautiful UI's `cn` (lib/utils): conditional class names with Tailwind conflict resolution. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
