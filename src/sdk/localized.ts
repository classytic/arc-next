/**
 * Bilingual field helpers. Server-safe, no dependencies. A text field is either a plain string with
 * a sibling in the other language (`title` + `titleAr`) or a `{ en, ar }` object.
 */

/** A bilingual text field as the wire carries it (`en` always, `ar` when translated). */
export interface BilingualText {
  en: string;
  ar?: string;
}

/** The text in the viewer's language, falling back to English. */
export function localized(value: BilingualText | undefined, locale: "en" | "ar"): string {
  if (!value) return "";
  return locale === "ar" && value.ar ? value.ar : value.en;
}

/** A named thing that may carry an Arabic sibling next to its English field. */
export interface NamedEntity {
  title?: string | BilingualText | undefined;
  titleAr?: string | undefined;
  name?: string | BilingualText | undefined;
  nameAr?: string | undefined;
  label?: string | BilingualText | undefined;
  labelAr?: string | undefined;
}

const NAME_FIELDS = [
  ["title", "titleAr"],
  ["name", "nameAr"],
  ["label", "labelAr"],
] as const;

/**
 * THE name helper for entities that carry a title, a name or a label: the Arabic sibling when the
 * viewer reads Arabic and it is set (`titleAr`, `nameAr`, `labelAr`, first non-blank), else the
 * English text (or the `ar` of a bilingual value), else an empty string. Never throws on a wire
 * that does not carry Arabic yet.
 */
export function localizedName(entity: NamedEntity | null | undefined, locale: "en" | "ar"): string {
  if (!entity) return "";
  if (locale === "ar") {
    for (const [, arKey] of NAME_FIELDS) {
      const ar = entity[arKey]?.trim();
      if (ar) return ar;
    }
  }
  for (const [key] of NAME_FIELDS) {
    const value = entity[key];
    if (typeof value === "string" && value) return value;
    if (value && typeof value === "object") return localized(value, locale);
  }
  return "";
}
