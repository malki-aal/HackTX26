// Original low-poly silhouettes used as the app's default avatars, even when a sign-in provider has a photo.
// They are decoration. Which one shows follows the verified role and never grants anything.

export type AvatarRole = "employee" | "executive";

export function Avatar({ role, size = 40, label }: { role: AvatarRole; size?: number; label?: string }) {
  const id = `av-${role}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className="shrink-0 rounded-full"
    >
      <defs>
        <clipPath id={id}>
          <circle cx="32" cy="32" r="32" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id})`}>{role === "executive" ? <Executive /> : <Employee />}</g>
    </svg>
  );
}

/** Professional: black backdrop, grey suit jacket, light shirt, darker tie. */
function Executive() {
  return (
    <>
      <polygon points="0,0 64,0 64,34 0,34" fill="#050505" />
      <polygon points="0,34 64,34 64,64 0,64" fill="#0D0D0D" />
      <polygon points="0,0 40,0 0,30" fill="#111111" />
      <polygon points="64,0 64,36 34,0" fill="#000000" />
      {/* jacket */}
      <polygon points="6,64 12,51 27,46 25,64" fill="#5A5A5A" />
      <polygon points="58,64 52,51 37,46 39,64" fill="#444444" />
      <polygon points="12,51 32,45 52,51 50,54 32,48.5 14,54" fill="#6E6E6E" />
      {/* shirt and tie */}
      <polygon points="27,46 32,60 37,46 32,44" fill="#E4E4E4" />
      <polygon points="30.5,48 33.5,48 34.5,58 32,62 29.5,58" fill="#8C8C8C" />
      <polygon points="30.5,48 33.5,48 32,51" fill="#6A6A6A" />
      {/* neck and head */}
      <polygon points="28,38 36,38 37,46 32,48 27,46" fill="#9A9A9A" />
      <polygon points="32,13 42,18 44,29 38,40 26,40 20,29 22,18" fill="#BDBDBD" />
      <polygon points="32,13 42,18 44,29 32,26" fill="#A8A8A8" />
      <polygon points="32,26 44,29 38,40 32,40" fill="#9E9E9E" />
      <polygon points="22,18 32,11 42,18 40,21 32,18 24,21" fill="#2A2A2A" />
    </>
  );
}

/** Casual: black backdrop, light grey tee, the familiar default-profile shape. */
function Employee() {
  return (
    <>
      <polygon points="0,0 64,0 64,36 0,36" fill="#080808" />
      <polygon points="0,36 64,36 64,64 0,64" fill="#101010" />
      <polygon points="0,0 36,0 0,28" fill="#141414" />
      <polygon points="64,0 64,30 38,0" fill="#030303" />
      {/* tee */}
      <polygon points="7,64 12,52 32,46 52,52 57,64" fill="#D2D2D2" />
      <polygon points="32,46 52,52 57,64 36,64" fill="#B4B4B4" />
      <polygon points="26,47 32,56 38,47 32,45" fill="#8E8E8E" />
      {/* neck and head */}
      <polygon points="28,38 36,38 38,46 32,50 26,46" fill="#C4C4C4" />
      <polygon points="32,14 41,18 43,28 38,38 26,38 21,28 23,18" fill="#E2E2E2" />
      <polygon points="32,14 41,18 43,28 32,25" fill="#CFCFCF" />
      <polygon points="32,25 43,28 38,38 32,38" fill="#BEBEBE" />
      <polygon points="23,18 32,12 41,18 39,21 32,18 25,21" fill="#6A6A6A" />
    </>
  );
}
