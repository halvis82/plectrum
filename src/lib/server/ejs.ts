import "server-only";
import { readFileSync } from "fs";
import { join } from "path";

// yt-dlp's challenge solver (github.com/yt-dlp/ejs v0.8.0, Unlicense), vendored. It deciphers YouTube's
// signature and "n" challenges from the player JS and is kept current by the yt-dlp team.
const dir = join(process.cwd(), "src/lib/server/ejs");
let solver: ((input: unknown) => SolverOutput) | null = null;

type SolverOutput = {
  type: "result" | "error";
  error?: string;
  preprocessed_player?: string;
  responses?: { type: "result" | "error"; data?: Record<string, string>; error?: string }[];
};

function load() {
  if (solver) return solver;
  const lib = readFileSync(join(dir, "yt.solver.lib.js"), "utf8");
  const core = readFileSync(join(dir, "yt.solver.core.js"), "utf8");
  solver = new Function("input", `${lib}\nObject.assign(globalThis, lib);\n${core}\nreturn jsc(input);`) as (input: unknown) => SolverOutput;
  return solver;
}

const players = new Map<string, Promise<string>>();
const preprocessed = new Map<string, string>();

function playerJs(playerId: string) {
  let p = players.get(playerId);
  if (!p) {
    p = fetch(`https://www.youtube.com/s/player/${playerId}/player_ias.vflset/en_US/base.js`).then((r) => {
      if (!r.ok) throw new Error(`player JS HTTP ${r.status}`);
      return r.text();
    });
    p.catch(() => players.delete(playerId));
    players.set(playerId, p);
  }
  return p;
}

/** Solves sig and n challenges for a player. Returns maps from challenge to answer. */
export async function solve(playerId: string, sig: string[], n: string[]): Promise<{ sig: Record<string, string>; n: Record<string, string> }> {
  const requests = [
    ...(sig.length ? [{ type: "sig", challenges: sig }] : []),
    ...(n.length ? [{ type: "n", challenges: n }] : []),
  ];
  const pre = preprocessed.get(playerId);
  const input = pre
    ? { type: "preprocessed", preprocessed_player: pre, requests }
    : { type: "player", player: await playerJs(playerId), requests, output_preprocessed: true };
  const out = load()(input);
  if (out.type === "error") throw new Error(`challenge solver: ${out.error}`);
  if (out.preprocessed_player) preprocessed.set(playerId, out.preprocessed_player);
  const result = { sig: {} as Record<string, string>, n: {} as Record<string, string> };
  requests.forEach((r, i) => {
    const res = out.responses?.[i];
    if (!res || res.type === "error") throw new Error(`challenge solver (${r.type}): ${res?.error ?? "no response"}`);
    Object.assign(r.type === "sig" ? result.sig : result.n, res.data);
  });
  return result;
}

/** Turns a format's signatureCipher/url into a playable URL using the solver. */
export async function decipherUrl(playerId: string, format: { url?: string; signature_cipher?: string; cipher?: string }): Promise<string> {
  const sc = format.signature_cipher ?? format.cipher;
  const params = sc ? new URLSearchParams(sc) : null;
  const url = new URL(params ? params.get("url")! : format.url!);
  const s = params?.get("s");
  const n = url.searchParams.get("n");
  const answers = await solve(playerId, s ? [s] : [], n ? [n] : []);
  if (s) url.searchParams.set(params!.get("sp") ?? "signature", answers.sig[s]);
  if (n) url.searchParams.set("n", answers.n[n]);
  return url.toString();
}
