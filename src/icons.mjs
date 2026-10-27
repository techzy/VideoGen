/**
 * Line icons on a 64×64 grid, stroke only, so every one can be drawn on
 * with stroke-dashoffset (each path gets pathLength="1").
 */
export const ICONS = {
  money: [
    "M32 6a26 26 0 1 0 .01 0z",
    "M40 22c-2-3-5-4-8-4-5 0-8 2.5-8 6 0 9 17 5 17 14 0 4-4 7-9 7-4 0-7-1.5-9-4.5",
    "M32 13v38",
  ],
  company: [
    "M12 56V12h26v44",
    "M38 26h14v30",
    "M6 56h52",
    "M19 20h4M28 20h4M19 30h4M28 30h4M19 40h4M28 40h4",
    "M44 34h2M44 44h2",
  ],
  graduation: ["M4 26 32 14l28 12-28 12z", "M16 32v12c0 4 7 8 16 8s16-4 16-8V32", "M58 27v15"],
  rocket: [
    "M32 5c10 8 14 20 12 33H20C18 25 22 13 32 5z",
    "M20 38l-8 11h10",
    "M44 38l8 11H42",
    "M27 46l5 11 5-11",
    "M28 22a4 4 0 1 0 8 0a4 4 0 1 0-8 0",
  ],
  clock: ["M32 6a26 26 0 1 0 .01 0z", "M32 16v16l11 7"],
  hourglass: [
    "M16 6h32M16 58h32",
    "M21 6c0 15 21 17 21 26S21 43 21 58",
    "M43 6c0 15-21 17-21 26s21 11 21 26",
    "M26 52h12",
  ],
  work: ["M8 22h48v32H8z", "M24 22v-6h16v6", "M8 36h48", "M29 33v6h6v-6"],
  home: ["M8 30 32 10l24 20", "M14 25v29h36V25", "M27 54V40h10v14"],
  family: [
    "M14 22a7 7 0 1 0 14 0a7 7 0 1 0-14 0",
    "M36 22a7 7 0 1 0 14 0a7 7 0 1 0-14 0",
    "M6 54c0-10 6-17 15-17s15 7 15 17",
    "M30 46c2-6 6-9 12-9 9 0 15 7 15 17",
  ],
  heart: ["M32 54S8 40 8 24c0-8 6-14 13-14 5 0 9 3 11 7 2-4 6-7 11-7 7 0 13 6 13 14 0 16-24 30-24 30z"],
  growth: ["M8 8v48h48", "M14 46l12-14 9 8 17-20", "M44 20h8v8"],
  decline: ["M8 8v48h48", "M14 18l12 14 9-8 17 20", "M44 44h8v-8"],
  warning: ["M32 7 59 55H5z", "M32 24v15", "M32 46v2"],
  calendar: [
    "M8 14h48v42H8z",
    "M8 26h48",
    "M20 8v12M44 8v12",
    "M18 36h6M30 36h6M42 36h6M18 46h6M30 46h6",
  ],
  document: ["M14 6h26l12 12v40H14z", "M40 6v12h12", "M22 30h20M22 38h20M22 46h12"],
  idea: ["M24 44c0-8-8-12-8-22a16 16 0 0 1 32 0c0 10-8 14-8 22z", "M24 50h16", "M26 56h12"],
  question: ["M32 6a26 26 0 1 0 .01 0z", "M24 25a8 8 0 1 1 11 7.5c-2 1-3 2.5-3 5V40", "M32 46v2"],
  target: [
    "M32 8a24 24 0 1 0 .01 0z",
    "M32 18a14 14 0 1 0 .01 0z",
    "M32 28a4 4 0 1 0 .01 0z",
    "M32 32 54 10",
    "M47 10h7v7",
  ],
  lock: ["M14 28h36v28H14z", "M22 28v-8a10 10 0 0 1 20 0v8", "M32 38v8"],
  forever: [
    "M32 32c-6-8-10-12-16-12a12 12 0 0 0 0 24c6 0 10-4 16-12s10-12 16-12a12 12 0 0 1 0 24c-6 0-10-4-16-12z",
  ],
  boom: ["M36 4 14 36h16l-4 24 24-34H34z"],
  people: [
    "M24 20a8 8 0 1 0 16 0a8 8 0 1 0-16 0",
    "M16 56c0-11 7-18 16-18s16 7 16 18",
    "M6 50c0-7 4-12 10-13M58 50c0-7-4-12-10-13",
  ],
  check: ["M32 6a26 26 0 1 0 .01 0z", "M20 33l8 8 16-17"],
  cross: ["M32 6a26 26 0 1 0 .01 0z", "M22 22l20 20M42 22 22 42"],
};

export const ICON_NAMES = Object.keys(ICONS);

export function iconSvg(name, { size = 120, stroke = "#fff", width = 4, id = "" } = {}) {
  const paths = ICONS[name] || ICONS.idea;
  const body = paths
    .map(
      (d) =>
        `<path class="draw" d="${d}" pathLength="1" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join("");
  return `<svg${id ? ` id="${id}"` : ""} viewBox="0 0 64 64" width="${size}" height="${size}" overflow="visible">${body}</svg>`;
}
