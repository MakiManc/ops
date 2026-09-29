/**
 * The handful of styles every screen shares.
 *
 * Each of these was previously an inline Tailwind string, redefined slightly
 * differently in several files. Keeping them here means a button looks like a button
 * on every screen, and the contrast rules in index.css are honoured in one place.
 *
 * The brand, and what each colour is for:
 *   Maki Orange  — the one thing to press on a screen. Woodsmoke text on it, never white.
 *   Everglade    — the header, and quieter secondary actions. White text is fine here.
 *   Cherry       — a soft highlight for "this is yours / this changed". Woodsmoke text.
 */

/** The primary action: one per screen, in Maki Orange. */
export const btnPrimary =
  'inline-flex items-center justify-center min-h-[48px] px-5 rounded-xl bg-maki-orange text-woodsmoke '
  + 'font-semibold shadow-sm hover:brightness-95 active:brightness-90 '
  + 'disabled:bg-gray-300 disabled:text-gray-600 disabled:shadow-none'

/** A secondary action in Everglade. */
export const btnSecondary =
  'inline-flex items-center justify-center min-h-[44px] px-4 rounded-xl bg-everglade text-paper '
  + 'font-semibold hover:bg-[#245a4f] active:bg-[#163a33] disabled:opacity-60'

/** A quiet action: an outlined button on a white card. */
export const btnQuiet =
  'inline-flex items-center justify-center min-h-[44px] px-4 rounded-xl border border-gray-400 '
  + 'bg-white text-gray-900 font-medium hover:border-everglade hover:text-everglade disabled:opacity-60'

/** A destructive action, still quiet: outlined in red so it is never pressed by accident. */
export const btnDanger =
  'inline-flex items-center justify-center min-h-[44px] px-4 rounded-xl border border-red-700 '
  + 'bg-white text-red-800 font-medium hover:bg-red-50 disabled:opacity-60'

/** A card: the white panel most content sits in. */
export const card = 'bg-white border border-gray-200 rounded-2xl p-4 shadow-sm'

/** A text input. */
export const input =
  'w-full min-h-[44px] rounded-xl border border-gray-400 bg-white px-3 py-2 text-gray-900 '
  + 'placeholder:text-gray-500'

/** The small uppercase label above a group of things. */
export const eyebrow = 'text-xs font-semibold uppercase tracking-wider text-everglade'
