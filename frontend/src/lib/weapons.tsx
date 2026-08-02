// A single, consistent weapon icon set — one optical density, one 24-grid,
// legible at 16px. Rather than 30 mismatched silhouettes we map every weapon to
// a class glyph (the reference's main sin was inconsistent weights/sizes).

export type WeaponClass =
  | "pistol"
  | "rifle"
  | "sniper"
  | "smg"
  | "shotgun"
  | "mg"
  | "knife"
  | "he"
  | "flash"
  | "smoke"
  | "molotov"
  | "decoy"
  | "c4"
  | "none";

const RULES: [RegExp, WeaponClass][] = [
  [/knife|dagger|bayonet|karambit|kukri|talon|ursus|nomad|stiletto|navaja|paracord|skeleton|widowmaker/i, "knife"],
  [/awp|ssg|scar-?20|g3sg1|scout/i, "sniper"],
  [/ak-?47|m4a1|m4a4|galil|famas|aug|sg ?553|sg553/i, "rifle"],
  [/mp9|mac-?10|mp7|mp5|ump|bizon|p90/i, "smg"],
  [/nova|xm1014|sawed|mag-?7/i, "shotgun"],
  [/m249|negev/i, "mg"],
  [/incendiary|molotov/i, "molotov"],
  [/flash/i, "flash"],
  [/smoke/i, "smoke"],
  [/decoy/i, "decoy"],
  [/high explosive|grenade$|^he$/i, "he"],
  [/c4|explosive/i, "c4"],
  [/usp|glock|deagle|desert eagle|tec-?9|p2000|p250|five-?seven|cz75|dual|revolver|r8|hkp2000/i, "pistol"],
];

export function weaponClass(name: string | null | undefined): WeaponClass {
  if (!name) return "none";
  for (const [re, cls] of RULES) if (re.test(name)) return cls;
  return "none";
}

// Filled silhouettes on a 24×24 grid; fill=currentColor so colour is inherited.
const PATHS: Record<WeaponClass, string> = {
  pistol: "M4 10h8V8h4l2 2v2h1v2h-6v-1h-1v3h-2v-3H5v-1H4z",
  rifle: "M2 10h12l2-2h3l3 1v2h-3v1h-9v2h-2v-2H4v3H2z",
  sniper: "M2 10h20v2h-3v1h-2v-1H8v3H6v-3H2z M15 7a2 2 0 110 4 2 2 0 010-4z",
  smg: "M4 10h9V8h3v2h2v2h-7v2h-2v-2H5v2H3z",
  shotgun: "M2 11h20v1h-3v1h-2v-1H6v2H4v-2H2z",
  mg: "M2 10h12V8h4v2h2v2h-6v2h-3v-2H6v3H4v-3H2z",
  knife: "M3 16L16 5c2-1 3 1 2 2L8 18l-2 1H3z",
  he: "M12 4a6 6 0 016 6c0 5-6 10-6 10S6 15 6 10a6 6 0 016-6z",
  flash: "M10 3h4v3l-1 1v10a1.6 1.6 0 01-2 0V7l-1-1z",
  smoke: "M9 4h6v2H9z M10 7h4v9a2 2 0 01-4 0z",
  molotov: "M10 3h4v3l2 3v9a1 1 0 01-1 1h-6a1 1 0 01-1-1V9l2-3z",
  decoy: "M9 4h6v2l-1 1v9a2 2 0 01-4 0V7L9 6z",
  c4: "M5 8h14v10H5z M11 5h2v3h-2z M8 11h3v3H8z",
  none: "M6 11h12v2H6z",
};

export function WeaponIcon({
  name,
  size = 16,
  className = "",
}: {
  name: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const cls = weaponClass(name);
  if (cls === "none") return null;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={name ?? "weapon"}
    >
      <path d={PATHS[cls]} fill="currentColor" />
    </svg>
  );
}
