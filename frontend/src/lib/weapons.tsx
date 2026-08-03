// Real CS2 weapon/grenade icons — the official monochrome equipment SVGs from
// the game files (via Juknum/counter-strike-icons), bundled in
// public/icons/weapons/. We map both naming conventions the data uses:
//   * kill events carry internal names ("ak47", "usp_silencer", "hegrenade")
//   * the scoreboard carries display names ("AK-47", "USP-S", "Smoke Grenade")

const BASE = import.meta.env.BASE_URL;

// the filenames we actually shipped (== CS2 internal weapon names)
const FILES = new Set([
  "ak47", "m4a1", "m4a1_silencer", "aug", "sg556", "galilar", "famas",
  "awp", "ssg08", "scar20", "g3sg1", "deagle", "revolver", "glock",
  "usp_silencer", "hkp2000", "p250", "fiveseven", "tec9", "cz75a", "elite",
  "mp9", "mac10", "mp7", "mp5sd", "ump45", "bizon", "p90", "nova", "xm1014",
  "sawedoff", "mag7", "m249", "negev", "hegrenade", "flashbang",
  "smokegrenade", "molotov", "incgrenade", "decoy", "knife", "c4", "taser",
]);

// display name (or grenade label) -> filename, when it isn't already a filename
const DISPLAY: [RegExp, string][] = [
  [/knife|dagger|bayonet|karambit|kukri|talon|ursus|nomad|stiletto|navaja|paracord|skeleton|widowmaker|butterfly|falchion|shadow|bowie|huntsman|gut|flip|classic/i, "knife"],
  [/^ak-?47/i, "ak47"],
  [/m4a1-?s|m4a1_?silencer/i, "m4a1_silencer"],
  [/m4a4|^m4a1$|^m4/i, "m4a1"],
  [/awp/i, "awp"],
  [/ssg ?08|scout/i, "ssg08"],
  [/scar-?20/i, "scar20"],
  [/g3sg1/i, "g3sg1"],
  [/aug/i, "aug"],
  [/sg ?553|sg556/i, "sg556"],
  [/galil/i, "galilar"],
  [/famas/i, "famas"],
  [/desert eagle|deagle/i, "deagle"],
  [/r8|revolver/i, "revolver"],
  [/glock/i, "glock"],
  [/usp/i, "usp_silencer"],
  [/p2000|hkp2000/i, "hkp2000"],
  [/p250/i, "p250"],
  [/five-?seven|fiveseven/i, "fiveseven"],
  [/tec-?9/i, "tec9"],
  [/cz75/i, "cz75a"],
  [/dual|elite|berettas/i, "elite"],
  [/mp9/i, "mp9"],
  [/mac-?10/i, "mac10"],
  [/mp7/i, "mp7"],
  [/mp5/i, "mp5sd"],
  [/ump/i, "ump45"],
  [/bizon/i, "bizon"],
  [/p90/i, "p90"],
  [/nova/i, "nova"],
  [/xm1014/i, "xm1014"],
  [/sawed/i, "sawedoff"],
  [/mag-?7/i, "mag7"],
  [/m249/i, "m249"],
  [/negev/i, "negev"],
  [/high explosive|hegrenade|^he$/i, "hegrenade"],
  [/flash/i, "flashbang"],
  [/smoke/i, "smokegrenade"],
  [/incendiary|incgrenade/i, "incgrenade"],
  [/molotov/i, "molotov"],
  [/decoy/i, "decoy"],
  [/zeus|taser/i, "taser"],
  [/c4|bomb|explosive/i, "c4"],
];

export function iconFile(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name.toLowerCase().replace(/^weapon_/, "").trim();
  if (FILES.has(n)) return n;
  if (/knife|bayonet|karambit|dagger/.test(n)) return "knife";
  for (const [re, file] of DISPLAY) if (re.test(name)) return file;
  return null;
}

export function WeaponIcon({
  name,
  h = 14,
  className = "",
}: {
  name: string | null | undefined;
  h?: number;
  className?: string;
}) {
  const file = iconFile(name);
  if (!file) return null;
  return (
    <img
      src={`${BASE}icons/weapons/${file}.svg`}
      alt={name ?? "weapon"}
      title={name ?? undefined}
      draggable={false}
      style={{ height: h, width: "auto", maxWidth: h * 3 }}
      className={className}
    />
  );
}
