import auroraDrift from "@/assets/wallpapers/aurora-drift.jpg";
import emberRidge from "@/assets/wallpapers/ember-ridge.jpg";
import honeyDusk from "@/assets/wallpapers/honey-dusk.jpg";
import mossLight from "@/assets/wallpapers/moss-light.jpg";
import orchidHaze from "@/assets/wallpapers/orchid-haze.jpg";
import tidePool from "@/assets/wallpapers/tide-pool.jpg";

export type WallpaperId =
  | "aurora-drift"
  | "ember-ridge"
  | "tide-pool"
  | "moss-light"
  | "orchid-haze"
  | "honey-dusk";

export interface Wallpaper {
  id: WallpaperId;
  name: string;
  src: string;
}

export const WALLPAPERS: readonly Wallpaper[] = [
  { id: "aurora-drift", name: "Aurora Drift", src: auroraDrift },
  { id: "ember-ridge", name: "Ember Ridge", src: emberRidge },
  { id: "tide-pool", name: "Tide Pool", src: tidePool },
  { id: "moss-light", name: "Moss Light", src: mossLight },
  { id: "orchid-haze", name: "Orchid Haze", src: orchidHaze },
  { id: "honey-dusk", name: "Honey Dusk", src: honeyDusk },
];

/** Reserved id for the single wallpaper the user picked from their device. */
export const CUSTOM_WALLPAPER_ID = "custom";

export function findWallpaper(id: string | null): Wallpaper | undefined {
  if (!id) return undefined;
  return WALLPAPERS.find((wallpaper) => wallpaper.id === id);
}
