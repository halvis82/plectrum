"use client";
// YouTube player driven over the embed's postMessage protocol, on youtube-nocookie.com.
// Avoids www.youtube.com/iframe_api entirely, so it also works where youtube.com is blocked
// (hosts files, school/work filters) as long as the embed domain is reachable.

export const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;

export type YTPlayer = {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(s: number): void;
  setVolume(v: number): void;
  unMute(): void;
  /** interpolated between the player's ~4 Hz time reports */
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  destroy(): void;
};

const ORIGIN = "https://www.youtube-nocookie.com";

export function createPlayer(
  container: HTMLElement,
  videoId: string,
  onState?: (state: number) => void,
  onError?: (code: number) => void,
): Promise<YTPlayer> {
  const iframe = document.createElement("iframe");
  const params = new URLSearchParams({
    enablejsapi: "1",
    playsinline: "1",
    rel: "0",
    modestbranding: "1",
    origin: location.origin,
    widget_referrer: location.href,
  });
  iframe.src = `${ORIGIN}/embed/${videoId}?${params}`;
  iframe.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
  iframe.referrerPolicy = "strict-origin-when-cross-origin";
  iframe.title = "YouTube player";
  iframe.className = "w-full h-full border-0";
  container.replaceChildren(iframe);

  let time = 0, stamp = performance.now(), state: number = YT_STATE.UNSTARTED, duration = 0, rate = 1;
  let destroyed = false;

  const send = (func: string, args: unknown[] = []) =>
    iframe.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args, id: 1, channel: "widget" }), ORIGIN);

  return new Promise((resolve, reject) => {
    let ready = false;
    const player: YTPlayer = {
      playVideo: () => send("playVideo"),
      pauseVideo: () => send("pauseVideo"),
      seekTo: (s) => {
        time = s;
        stamp = performance.now();
        send("seekTo", [s, true]);
      },
      setVolume: (v) => send("setVolume", [v]),
      unMute: () => send("unMute"),
      getCurrentTime: () => (state === YT_STATE.PLAYING ? time + ((performance.now() - stamp) / 1000) * rate : time),
      getDuration: () => duration,
      getPlayerState: () => state,
      destroy: () => {
        destroyed = true;
        removeEventListener("message", onMessage);
        clearInterval(listen);
        iframe.remove();
      },
    };

    function onMessage(e: MessageEvent) {
      if (e.source !== iframe.contentWindow || typeof e.data !== "string") return;
      let msg: { event?: string; info?: unknown };
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      const info = msg.info as Record<string, unknown> | number | null;
      if ((msg.event === "infoDelivery" || msg.event === "initialDelivery") && info && typeof info === "object") {
        if (typeof info.currentTime === "number") {
          time = info.currentTime;
          stamp = performance.now();
        }
        if (typeof info.duration === "number" && info.duration > 0) duration = info.duration;
        if (typeof info.playbackRate === "number") rate = info.playbackRate;
        if (typeof info.playerState === "number" && info.playerState !== state) {
          state = info.playerState;
          onState?.(state);
        }
      } else if (msg.event === "onStateChange" && typeof info === "number") {
        if (info !== state) {
          state = info;
          stamp = performance.now();
          onState?.(state);
        }
      } else if (msg.event === "onReady" && !ready) {
        ready = true;
        clearInterval(listen);
        resolve(player);
      } else if (msg.event === "onError" && typeof info === "number") {
        onError?.(info);
      }
    }
    addEventListener("message", onMessage);

    // the embed only starts talking after it hears "listening"
    const listen = setInterval(() => {
      iframe.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: 1, channel: "widget" }), ORIGIN);
    }, 250);
    setTimeout(() => {
      if (!ready && !destroyed) {
        clearInterval(listen);
        reject(new Error("The YouTube player didn't load. YouTube may be blocked on this network."));
      }
    }, 20000);
  });
}
