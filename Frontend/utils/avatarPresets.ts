/**
 * The susej avatar set — 10 consistent 2D illustrations, hosted on our own
 * Cloudinary account (cloud name dmrjvlzxe) so they are reachable from every
 * device, offline-cached after first load, and never depend on a third party.
 *
 * Why hosted URLs and not bundled `require()` assets: picking a preset must be
 * INSTANT and must never fail. The old presets were local asset ids that were
 * uploaded to the server on every tap, so choosing an avatar depended on a live
 * network call - and since a profile picture is now MANDATORY, any failed
 * upload became a hard dead end on the screen with no way out.
 *
 * Set: 5 men + 5 women, deliberately diverse (hijab, turban, dupatta, glasses,
 * beard, headphones, curly hair) to match the marketplace's audience.
 * Gender coverage and style consistency were audited cell-by-cell on the source
 * grid before slicing.
 */
export const AVATAR_PRESET_URLS: readonly string[] = [
  'https://res.cloudinary.com/dmrjvlzxe/image/upload/v1790404592/susej/ylsgpggfpvzknjxi4sxl.png',
  'https://res.cloudinary.com/dmrjvlzxe/image/upload/v1790404594/susej/yvxfg0j3cnjfemqbhgst.png',
  'https://res.cloudinary.com/dmrjvlzxe/image/upload/v1790404597/susej/hhyonpswnptas5hknh1z.png',
  'https://res.cloudinary.com/dmrjvlzxe/image/upload/v1790404599/susej/ylnxn6ehqtxdyuavgsnm.png',
  'https://res.cloudinary.com/dmrjvlzxe/image/upload/v1790404602/susej/hzewppgx9neoe7pnat21.png',
  'https://res.cloudinary.com/dmrjvlzxe/image/upload/v1790404604/susej/itdiwag5yzy0gv9datxi.png',
  'https://res.cloudinary.com/dmrjvlzxe/image/upload/v1790404606/susej/dodsdliy8ljuio2n865u.png',
  'https://res.cloudinary.com/dmrjvlzxe/image/upload/v1790404608/susej/ts51upf8rf9ooi7kuad5.png',
  'https://res.cloudinary.com/dmrjvlzxe/image/upload/v1790404611/susej/qihshy2jo8vf2jaxjx1o.png',
  'https://res.cloudinary.com/dmrjvlzxe/image/upload/v1790404613/susej/nptxbeju4xtdwbdovxkz.png',
];

/**
 * Neutral "no photo yet" placeholder, inlined as a data URI.
 *
 * This REPLACES a third-party generated-avatar call that invented a random
 * face for anyone without a picture. A generated portrait is a fabricated
 * identity, it leaked every viewed username to an outside service, and it broke
 * to a blank circle whenever the device was offline. The placeholder is honest
 * about being empty instead of pretending to be a person.
 */
export const NO_PHOTO_PLACEHOLDER =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAV0lEQVRoge3PMQ0AMAzAsPIn3ZFRy0kZK5HkiTJkiRJkiRJkiRJkiRJ0r9333wMAWmX2gABJ7VYcAAAAAElFTkSuQmCC';
