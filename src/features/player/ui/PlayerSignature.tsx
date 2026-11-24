/**
 * A quiet product signature rather than a feature.
 *
 * The bottom-right corner is the only place in the fullscreen player that never
 * holds a control, and watermark-level contrast keeps it out of the way of the
 * cover, the transport and the lyrics.
 */
export function PlayerSignature() {
  return (
    <div className="pointer-events-none absolute right-3 bottom-1.5 z-30 text-[10px] font-[500] tracking-[0.02em] text-white/25 select-none">
      Helped by Freebuff &amp; Aedan
    </div>
  );
}
