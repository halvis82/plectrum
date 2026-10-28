// The app was called ChordCatch and lived at these addresses. Recordings and uploads keep their audio
// on the device, under the address they were made at, so the old addresses hand it over (see Moved).

export const HOME = "https://strum.vercel.app";
export const OLD_HOSTS = ["chordcatch-seven.vercel.app", "chord-catch.vercel.app", "chordcatch-personal-0972.vercel.app"];

/** What an old address sends the new one's /move page. */
export type Handover = { type: "handover"; audio: [string, Blob][]; prefs: [string, string][] };
