// esbuild spike: can a function import from a lib/ subdirectory?
export function spikeCheck(x) { return { ok: true, doubled: x * 2, from: 'lib/_spike.mjs' }; }
