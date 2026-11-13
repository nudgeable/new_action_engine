/**
 * Images in WhatsApp messages (template IMAGE headers, interactive headers).
 * WhatsApp downloads the image itself, so it needs an absolute, public https
 * URL to a JPEG or PNG of at most 5 MB — the action-images bucket qualifies
 * (public, PNG, ~200 KB; see scripts/action-image-compression.mjs).
 */
export function whatsAppImageLink(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
