// A peer's accent color is derived from its identity rather than assigned, so
// every screen shows the same peer in the same color without any shared state.
function peerHue(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

// Solid fill, used for avatar circles (matches the light-on-dark initials
// treatment established in the Penpot library).
export function peerAccentColor(seed: string): string {
  return `hsl(${peerHue(seed)} 55% 50%)`;
}

// A light-in-light/dark-in-dark tint, used for message bubble backgrounds
// (matches Penpot's PeerA/PeerBBackground tokens). Mixing into the current
// background token rather than computing an absolute lightness means this
// adapts to the color scheme automatically, without the caller re-deriving it.
export function peerBubbleColor(seed: string): string {
  return `color-mix(in srgb, hsl(${peerHue(seed)} 55% 50%) 22%, var(--brochain-background))`;
}

export const selfAccentColor = "var(--brochain-color-avatar)";
export const selfBubbleColor =
  "color-mix(in srgb, var(--brochain-color-avatar) 22%, var(--brochain-background))";
