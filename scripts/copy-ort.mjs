// Copies onnxruntime-web's WebAssembly runtime into public/ort/<version>/ so the analysis worker loads
// it from this site (versioned path, cached forever) instead of a third-party CDN. Runs before builds.
// The speech transcriber (transformers.js) brings its own onnxruntime-web, copied the same way.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

for (const pkg of ["node_modules/onnxruntime-web", "node_modules/@huggingface/transformers/node_modules/onnxruntime-web"]) {
  if (!existsSync(pkg)) continue;
  const dist = join(pkg, "dist");
  const { version } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
  const out = join("public/ort", version);
  mkdirSync(out, { recursive: true });
  for (const f of ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"])
    if (existsSync(join(dist, f))) copyFileSync(join(dist, f), join(out, f));
  console.log("onnxruntime-web", version, "->", out);
}
