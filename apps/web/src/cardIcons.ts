import type { CardId } from '../../../packages/engine/cards/types'

// Vendored SVGs for cards with no adequate dedicated Unicode emoji as of
// the emoji-test.txt release checked (2025-08-04, Emoji 17 draft) — see
// each entry below. Source: game-icons.net, CC BY 3.0
// (https://creativecommons.org/licenses/by/3.0/), via
// https://github.com/game-icons/icons. Authors: Lorc (dragonfly, vulture,
// salamander), Delapouite (ostrich, clownfish, sea-star), Caro Asercion
// (capybara, mole, axolotl). Icons stripped of their default black
// background tile and #fff fills so they inherit `currentColor` — see
// apps/web/src/assets/icons/*.svg.
export const VENDORED_ICON_IDS = [
  'dragonfly',
  'ostrich',
  'capybara',
  'clownfish',
  'vulture',
  'mole',
  'salamander',
  'axolotl',
  'starfish',
] as const

// Every id above resolves to `${id}.svg` in apps/web/src/assets/icons/.
export function vendoredIconUrl(id: (typeof VENDORED_ICON_IDS)[number]): string {
  return new URL(`./assets/icons/${id}.svg`, import.meta.url).href
}

// Emoji mapping for every other card id. A handful of ids that verified as
// genuinely missing a dedicated emoji, but where no vendored SVG was found
// either (game-icons.net has no dragonfly-family match for these), use the
// closest same-family/silhouette substitute noted inline rather than a
// misleading one (e.g. never reusing an already-assigned animal's emoji for
// a different card).
export const cardEmoji: Record<string, string> = {
  // --- Season 1 ---
  snail: '🐌',
  caterpillar: '🐛', // "bug" (U+1F41B) — Unicode's own larva/caterpillar-shaped glyph
  skunk: '🦨',
  bee: '🐝',
  eagle: '🦅',
  donkey: '🫏',
  butterfly: '🦋',
  dog: '🐶',
  goat: '🐐',
  sheep: '🐑', // codepoint name is "ewe"
  camel: '🐪',
  rabbit: '🐰',
  horse: '🐴',
  snake: '🐍',
  elephant: '🐘',
  rooster: '🐓',
  cat: '🐱',
  alligator: '🐊', // "crocodile" — no dedicated alligator emoji; same family, near-identical silhouette
  lion: '🦁',
  monkey: '🐒',
  pig: '🐷',
  peacock: '🦚',
  turkey: '🦃',
  bull: '🐂', // codepoint name is "ox"
  tiger: '🐯',
  deer: '🦌',
  bear: '🐻',
  cow: '🐄',
  // --- Season 2 ---
  grasshopper: '🦗', // codepoint name is "cricket" — closest/commonly-used stand-in, no dedicated grasshopper emoji
  mosquito: '🦟',
  ladybug: '🐞', // codepoint name is "lady beetle"
  spider: '🕷️',
  groundhog: '🦫', // "beaver" — no dedicated groundhog emoji or SVG match; closest burrowing-rodent silhouette
  rat: '🐀',
  goldfish: '🐠', // "tropical fish" — no dedicated goldfish emoji
  hen: '🐔', // codepoint name is "chicken"
  raccoon: '🦝',
  opossum: '🦡', // "badger" — no dedicated opossum emoji or SVG match; closest unused mid-size mammal silhouette
  mongoose: '🦦', // "otter" — no dedicated mongoose emoji or SVG match; closest unused slender mammal silhouette
  crow: '🐦‍⬛', // "black bird" (U+1F426 200D 2B1B)
  coyote: '🐺', // "wolf" — no dedicated coyote emoji; same family, near-identical silhouette
  fox: '🦊',
  crab: '🦀',
  gorilla: '🦍',
  zebra: '🦓',
  shark: '🦈',
  rhinoceros: '🦏',
  hippopotamus: '🦛',
  sloth: '🦥',
  firefly: '🪲', // "beetle" — no dedicated firefly emoji or SVG match; closest unused small-insect silhouette
  swordfish: '🐟', // "fish" — no dedicated swordfish emoji or SVG match; kept generic since 🐠/🦈 are already claimed
  platypus: '🦆', // "duck" — no dedicated platypus emoji or SVG match; bill shape is the closest available cue
  panther: '🐆', // "leopard" — no dedicated panther emoji or SVG match; closest unused big-cat silhouette
}

// Every one of the 62 card ids across season1.ts/season2.ts resolves here —
// either to an emoji string, or (for VENDORED_ICON_IDS) via vendoredIconUrl.
export function hasVendoredIcon(id: CardId): id is (typeof VENDORED_ICON_IDS)[number] {
  return (VENDORED_ICON_IDS as readonly string[]).includes(id)
}
