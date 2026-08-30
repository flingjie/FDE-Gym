export type ParsedHintLevel =
  | { ok: true; level: 1 | 2 | 3 | undefined }
  | { ok: false };

/** Parse `--level`. Absent → auto; only the strings "1"|"2"|"3" are explicit. */
export function parseHintLevel(raw: string | boolean | undefined): ParsedHintLevel {
  if (raw === undefined) return { ok: true, level: undefined };
  if (raw === "1" || raw === "2" || raw === "3") {
    return { ok: true, level: Number(raw) as 1 | 2 | 3 };
  }
  return { ok: false };
}
