import { ImageResponse } from "next/og";

// Original app icon: indigo square, white "R". Served as a PNG at /icons/180, /icons/192 and /icons/512.
export function generateStaticParams() {
  return [{ size: "180" }, { size: "192" }, { size: "512" }];
}

export async function GET(_req: Request, { params }: { params: Promise<{ size: string }> }) {
  const { size } = await params;
  const px = Math.min(512, Math.max(64, Number(size) || 192));
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#4f46e5",
          color: "#ffffff",
          fontSize: px * 0.62,
          fontWeight: 800,
        }}
      >
        R
      </div>
    ),
    { width: px, height: px },
  );
}
