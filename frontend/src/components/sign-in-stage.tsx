// Animated backdrop for the sign-in page: columns of small low-poly green "bills" that scroll up and down
// in alternating directions. Pure CSS animation, decoration only; it stands still with reduced motion.

const GREENS = ["#14532d", "#166534", "#15803d", "#22863a", "#4caf50", "#6fcf75", "#9be3a0", "#c4f0c6"];
const COLUMNS = 36;
const BILLS = 16;

// Deterministic so server and client render the same markup.
const pick = (i: number, salt: number) => {
  const n = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return Math.floor((n - Math.floor(n)) * GREENS.length);
};

function Bill({ seed }: { seed: number }) {
  const a = GREENS[pick(seed, 1)];
  let b = GREENS[pick(seed, 2)];
  if (b === a) b = GREENS[(pick(seed, 2) + 3) % GREENS.length];
  const c = GREENS[pick(seed, 3)];
  return (
    <div
      className="relative mb-3 h-[100px] w-[48px] shrink-0 overflow-hidden rounded-[3px]"
      style={{ background: `linear-gradient(${pick(seed, 4) % 2 ? 135 : 45}deg, ${a} 50%, ${b} 50%)` }}
    >
      {/* Facets and a centre emblem keep it reading as a note, not a plain block. */}
      <div className="absolute inset-[5px] rounded-[2px] border border-white/35" />
      <div className="absolute left-1/2 top-1/2 h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 rotate-45" style={{ background: c, opacity: 0.9 }} />
      <div className="absolute left-0 top-0 h-0 w-0 border-l-[16px] border-t-[16px] border-l-transparent" style={{ borderTopColor: "rgba(255,255,255,0.28)" }} />
    </div>
  );
}

function Column({ index }: { index: number }) {
  const up = index % 2 === 0;
  const bills = Array.from({ length: BILLS }, (_, k) => <Bill key={k} seed={index * 31 + k} />);
  return (
    <div className="shrink-0 overflow-visible">
      <div
        className={up ? "bills-up" : "bills-down"}
        style={{ animationDuration: `${34 + (index % 5) * 6}s`, animationDelay: `-${(index * 7) % 30}s` }}
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
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 flex justify-center gap-4 opacity-75">
        {Array.from({ length: COLUMNS }, (_, i) => (
          <Column key={i} index={i} />
        ))}
      </div>
      {children}
    </div>
  );
}
