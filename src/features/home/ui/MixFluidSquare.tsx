import { memo } from "react";
import { useTheme } from "next-themes";
import { useCoverFluidColors } from "../hooks/useCoverFluidColors";
import { withLightness } from "../lib/lightFluidColors";
import styles from "./MixFluidSquare.module.css";

export interface MixFluidSquareProps {
  coverUrl?: string;
  className?: string;
}

function MixFluidSquare({ coverUrl, className = "" }: MixFluidSquareProps) {
  const fluid = useCoverFluidColors(coverUrl);
  const { resolvedTheme } = useTheme();
  const isLight = resolvedTheme === "light";
  const color1 = isLight ? withLightness(fluid.color1, 0.62) : fluid.color1;
  const color2 = isLight ? withLightness(fluid.color2, 0.74) : fluid.color2;

  return (
    <div className={`${styles.container} ${className}`}>
      <div className={styles.base} style={{ backgroundColor: color1 }} />
      <div
        className={styles.blobBottomRight}
        style={{ backgroundColor: color2 }}
      />
      <div
        className={styles.blobCenterSwirl}
        style={{ backgroundColor: color2 }}
      />
      <div className={styles.blobTopLeft} style={{ backgroundColor: color1 }} />
      {/* The mark, as in the home reference: the mix icon is the Liner glyph on
          the cover's colour, not just a colour swatch. */}
      <svg
        viewBox="0 0 45 35"
        aria-hidden="true"
        className="absolute inset-0 m-auto h-[12px] w-[16px]"
        style={{ fill: "rgba(255,255,255,0.92)" }}
      >
        <path d="M4 0C1.79086 0 0 1.79086 0 4V27.2081C0 30.2751 3.30951 32.201 5.97608 30.6859L13.9629 26.1478C16.6295 24.6327 19.939 26.5587 19.939 29.6256V31C19.939 33.2091 21.7298 35 23.939 35H41C43.2091 35 45 33.2091 45 31V27.5586C45 25.3494 43.2091 23.5586 41 23.5586H35.2783C33.0691 23.5586 31.2783 21.7677 31.2783 19.5586V10.0519C31.2783 6.98497 27.9688 5.05899 25.3022 6.57411L17.3153 11.1121C14.6488 12.6273 11.3393 10.7013 11.3393 7.63433V4C11.3393 1.79086 9.54843 0 7.33929 0H4Z" />
      </svg>
    </div>
  );
}

export default memo(MixFluidSquare);
