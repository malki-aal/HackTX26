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

/** Professional: dark blue backdrop, suit jacket, white shirt, blue tie. */
function Executive() {
  return (
    <>
      <polygon points="0,0 64,0 64,34 0,34" fill="#1B3566" />
      <polygon points="0,34 64,34 64,64 0,64" fill="#244A8F" />
      <polygon points="0,0 40,0 0,30" fill="#2A4F96" />
      <polygon points="64,0 64,36 34,0" fill="#162C57" />
      {/* jacket */}
      <polygon points="6,64 12,51 27,46 25,64" fill="#3A4C74" />
      <polygon points="58,64 52,51 37,46 39,64" fill="#2C3C5F" />
      <polygon points="12,51 32,45 52,51 50,54 32,48.5 14,54" fill="#4B5F8C" />
      {/* shirt and tie */}
      <polygon points="27,46 32,60 37,46 32,44" fill="#F2F5FB" />
      <polygon points="30.5,48 33.5,48 34.5,58 32,62 29.5,58" fill="#0057D9" />
      <polygon points="30.5,48 33.5,48 32,51" fill="#0A47B0" />
      {/* neck and head */}
      <polygon points="28,38 36,38 37,46 32,48 27,46" fill="#B9C4DC" />
      <polygon points="32,13 42,18 44,29 38,40 26,40 20,29 22,18" fill="#D6DDEE" />
      <polygon points="32,13 42,18 44,29 32,26" fill="#C3CDE3" />
      <polygon points="32,26 44,29 38,40 32,40" fill="#BAC5DD" />
      <polygon points="22,18 32,11 42,18 40,21 32,18 24,21" fill="#26354F" />
    </>
  );
}

/** Casual: light blue backdrop, white tee, the familiar default-profile shape. */
function Employee() {
  return (
    <>
      <polygon points="0,0 64,0 64,36 0,36" fill="#CFE5FA" />
      <polygon points="0,36 64,36 64,64 0,64" fill="#B7D8F6" />
      <polygon points="0,0 36,0 0,28" fill="#DCEEFD" />
      <polygon points="64,0 64,30 38,0" fill="#C2DDF7" />
      {/* tee */}
      <polygon points="7,64 12,52 32,46 52,52 57,64" fill="#FFFFFF" />
      <polygon points="32,46 52,52 57,64 36,64" fill="#E4F0FC" />
      <polygon points="26,47 32,56 38,47 32,45" fill="#B7D8F6" />
      {/* neck and head */}
      <polygon points="28,38 36,38 38,46 32,50 26,46" fill="#F3F8FE" />
      <polygon points="32,14 41,18 43,28 38,38 26,38 21,28 23,18" fill="#FFFFFF" />
      <polygon points="32,14 41,18 43,28 32,25" fill="#EAF4FD" />
      <polygon points="32,25 43,28 38,38 32,38" fill="#DDEBFA" />
      <polygon points="23,18 32,12 41,18 39,21 32,18 25,21" fill="#7FB0E4" />
    </>
  );
}
