/**
 * Accent palettes.
 *
 * The app paints its highlights from three CSS variables (`--accent-primary`,
 * `--accent-secondary`, `--accent-tertiary`). Overriding them on the root
 * element gives a theme without touching Tailwind or the per-theme palette in
 * `globals.css`, and the choice survives a reload.
 */

export interface AccentTheme {
  id: string;
  label: string;
  accent: string;
  secondary: string;
  tertiary: string;
}

export const ACCENT_THEMES: readonly AccentTheme[] = [
  {
    id: "liner",
    label: "Liner Red",
    accent: "#ff3b3b",
    secondary: "#ff5c5c",
    tertiary: "#ff7d7d",
  },
  {
    id: "ocean",
    label: "Ocean",
    accent: "#2f80ed",
    secondary: "#56a0f5",
    tertiary: "#7db8fa",
  },
  {
    id: "emerald",
    label: "Emerald",
    accent: "#10b981",
    secondary: "#34d399",
    tertiary: "#6ee7b7",
  },
  {
    id: "violet",
    label: "Violet",
    accent: "#8b5cf6",
    secondary: "#a78bfa",
    tertiary: "#c4b5fd",
  },
  {
    id: "amber",
    label: "Amber",
    accent: "#f59e0b",
    secondary: "#fbbf24",
    tertiary: "#fcd34d",
  },
  {
    id: "rose",
    label: "Rose",
    accent: "#ec4899",
    secondary: "#f472b6",
    tertiary: "#f9a8d4",
  },
];

const STORAGE_KEY = "liner_accent_theme";
const DEFAULT_ACCENT_ID = "liner";

export function getAccentTheme(id: string | null): AccentTheme {
  return ACCENT_THEMES.find((theme) => theme.id === id) ?? ACCENT_THEMES[0]!;
}

export function getStoredAccentId(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return getAccentTheme(stored).id;
  } catch {
    return DEFAULT_ACCENT_ID;
  }
}

// globals.css maps these raw variables into Tailwind under `@theme inline`, and
// some utilities resolve the mapped name, so both have to move together.
const ACCENT_VARIABLES = [
  ["--accent-primary", "--color-accent-primary"],
  ["--accent-secondary", "--color-accent-secondary"],
  ["--accent-tertiary", "--color-accent-tertiary"],
] as const;

export function applyAccentTheme(id: string): void {
  if (typeof document === "undefined") return;
  const theme = getAccentTheme(id);
  const root = document.documentElement;
  // Always write the palette inline. The per-mode defaults in globals.css differ
  // from the swatches (dark red is lighter), so clearing the override for the
  // default palette made the same card look different in light and dark.
  const values = [theme.accent, theme.secondary, theme.tertiary];
  ACCENT_VARIABLES.forEach(([name, mapped], index) => {
    root.style.setProperty(name, values[index]!);
    root.style.setProperty(mapped, values[index]!);
  });
  root.dataset.accent = theme.id;
}

export function applyStoredAccentTheme(): void {
  applyAccentTheme(getStoredAccentId());
}

export function setAccentTheme(id: string): void {
  const theme = getAccentTheme(id);
  try {
    localStorage.setItem(STORAGE_KEY, theme.id);
  } catch {}
  applyAccentTheme(theme.id);
}
