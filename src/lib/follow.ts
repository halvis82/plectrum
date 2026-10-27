"use client";

/** Scrolls the sheet's own pane ([data-pane]) so `el` sits in the middle, without moving the page.
 * Holds off for a few seconds after the reader scrolls the pane themselves. */
export function followInPane(el: HTMLElement) {
  const pane = el.closest<HTMLElement>("[data-pane]");
  if (!pane || Number(pane.dataset.touched ?? 0) > Date.now() - 4000) return;
  // center it in the part of the pane that is on screen: below the sticky controls, above the player
  const box = pane.getBoundingClientRect();
  const controls = document.querySelector("[data-controls]")?.getBoundingClientRect().bottom ?? 0;
  const dock = document.querySelector("[data-dock]")?.getBoundingClientRect().top ?? innerHeight;
  const from = Math.max(box.top, controls), to = Math.min(box.bottom, innerHeight, dock);
  if (to - from < 40) return;
  const r = el.getBoundingClientRect();
  pane.scrollBy({ top: r.top + r.height / 2 - (from + to) / 2, behavior: "smooth" });
}

/** Marks the pane as scrolled by hand (wheel, touch, keys), which pauses following for a moment. */
export const touchPane = (e: { currentTarget: HTMLElement }) => (e.currentTarget.dataset.touched = String(Date.now()));
