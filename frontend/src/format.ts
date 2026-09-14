/** Render subject years gently. Always "1949 to 2026" when both are present. */
export function formatYears(
  birth: number | null | undefined,
  death: number | null | undefined
): string {
  if (birth && death) return `${birth} to ${death}`;
  if (birth) return `Born ${birth}`;
  if (death) return `Died ${death}`;
  return "";
}

/** Render milliseconds as m:ss for the recording timer and saved lengths. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** The first name for warm, personal copy. Falls back to the full name. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}
