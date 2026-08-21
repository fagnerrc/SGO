import { getClient, throwSupabaseError } from "./supabase";

export interface Branding {
  name: string;
  displayName: string | null;
  accentColor: string;
  logoUrl: string | null;
}

const DEFAULT_BRANDING: Branding = { name: "SGO", displayName: null, accentColor: "#1f6b45", logoUrl: null };

// Cached for the tab's lifetime, same pattern as getCachedProfile() in
// src/views/nav.ts — every screen needs this just to paint the sidebar
// logo/color, so it's fetched once at app boot rather than per-navigation.
let cached: Branding | null = null;

export async function getBranding(): Promise<Branding> {
  if (cached) return cached;
  const { data, error } = await getClient().rpc("current_company_branding");
  if (error) throwSupabaseError(error);
  // current_company_branding() is a set-returning function — an invalid
  // session correctly comes back as an empty array here (unlike
  // current_profile()'s single-row gotcha, see lib/profiles.ts), so a
  // plain empty-check is enough.
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) return DEFAULT_BRANDING;
  cached = { name: row.name, displayName: row.display_name, accentColor: row.accent_color, logoUrl: row.logo_url };
  return cached;
}

export function resetBrandingCache(): void {
  cached = null;
}

export async function updateBranding(input: { accentColor: string; displayName: string; logoUrl: string }): Promise<void> {
  const { error } = await getClient().rpc("update_company_branding", {
    p_accent_color: input.accentColor,
    p_display_name: input.displayName,
    p_logo_url: input.logoUrl,
  });
  if (error) throwSupabaseError(error);
  resetBrandingCache();
}

// Sets just the one CSS variable that actually needs to vary at runtime —
// every other brand-dependent token (--primary-dark, --primary-soft,
// --focus-ring) is defined in style.css via color-mix() against
// --primary, so they update automatically.
export function applyBranding(branding: Branding): void {
  document.documentElement.style.setProperty("--primary", branding.accentColor);
}
