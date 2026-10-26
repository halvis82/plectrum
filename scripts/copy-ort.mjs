// Copies onnxruntime-web's WebAssembly runtime into public/ort/<version>/ so the analysis worker loads
// it from this site (versioned path, cached forever) instead of a third-party CDN. Runs before builds.
import { copyFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

const dist = "node_modules/onnxruntime-web/dist";
const { version } = JSON.parse(readFileSync("node_modules/onnxruntime-web/package.json", "utf8"));
const out = join("public/ort", version);
mkdirSync(out, { recursive: true });
for (const f of ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) copyFileSync(join(dist, f), join(out, f));
console.log("onnxruntime-web", version, "->", out);
