import { spikeCheck } from './lib/_spike.mjs';
export default async () => new Response(JSON.stringify(spikeCheck(21)));
