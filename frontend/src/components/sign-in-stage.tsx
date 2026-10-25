// Animated backdrop for the sign-in page: columns of small low-poly green "bills" that scroll up and down
// in alternating directions. Pure CSS animation, decoration only; it stands still with reduced motion.

// Flat note in the reference style: a darker rim, a lighter face, notched corners, two dots and a centre
// medallion (no symbol on it). Each bill borrows one of these shade sets, so the field runs from dark to light green.
const THEMES = [
  { rim: "#2f8f2f", face: "#4cb04c", ink: "#2f8f2f" },
  { rim: "#14532d", face: "#2f8a43", ink: "#14532d" },
  { rim: "#1f6f35", face: "#45a35a", ink: "#1f6f35" },
  { rim: "#4caf50", face: "#a5e3a8", ink: "#3d9a42" },
  { rim: "#6fcf75", face: "#c9f2cb", ink: "#58b85e" },
  { rim: "#166534", face: "#3f9d52", ink: "#166534" },
];
const COLUMNS = 40;
const BILLS = 18;
const BILL_W = 36;
const BILL_H = 76;
const GAP_Y = 10;

// Deterministic so server and client render the same markup.
const pick = (i: number) => {
  const n = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return Math.floor((n - Math.floor(n)) * THEMES.length);
};

function Bill({ seed }: { seed: number }) {
  const t = THEMES[pick(seed)];
  return (
    <svg
      width={BILL_W}
      height={BILL_H}
      viewBox="0 0 48 100"
      className="shrink-0"
      style={{ marginBottom: GAP_Y }}
      aria-hidden
    >
      <rect width="48" height="100" rx="3" fill={t.rim} />
      <rect x="6" y="6" width="36" height="88" rx="2" fill={t.face} />
      <circle cx="6" cy="6" r="7" fill={t.ink} />
      <circle cx="42" cy="6" r="7" fill={t.ink} />
      <circle cx="6" cy="94" r="7" fill={t.ink} />
      <circle cx="42" cy="94" r="7" fill={t.ink} />
      <circle cx="24" cy="24" r="5" fill={t.ink} />
      <circle cx="24" cy="76" r="5" fill={t.ink} />
      <circle cx="24" cy="50" r="12" fill={t.ink} />
    </svg>
  );
}

function Column({ index }: { index: number }) {
  const up = index % 2 === 0;
  const bills = Array.from({ length: BILLS }, (_, k) => <Bill key={k} seed={index * 31 + k} />);
  return (
    <div className="shrink-0 overflow-visible">
      <div
        className={up ? "bills-up" : "bills-down"}
        style={{ animationDuration: `${(BILL_H + GAP_Y) * BILLS / (22 + (index % 5) * 5)}s`, animationDelay: `-${(index * 7) % 30}s` }}
      >
        {bills}
        {bills}
      </div>
    </div>
  );
}

export function SignInStage({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative isolate min-h-dvh overflow-hidden bg-[#dff2e2]">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 flex justify-center gap-3 opacity-80">
        {Array.from({ length: COLUMNS }, (_, i) => (
          <Column key={i} index={i} />
        ))}
      </div>
      {children}
    </div>
  );
}
