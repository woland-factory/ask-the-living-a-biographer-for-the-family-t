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
