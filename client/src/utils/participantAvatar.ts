// Keep camera-off cards consistent in the stage and the broadcast compositor.
export function getParticipantAvatarColors(name: string): [string, string] {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash % 360);
  return [`hsl(${hue}, 60%, 35%)`, `hsl(${(hue + 40) % 360}, 50%, 25%)`];
}
