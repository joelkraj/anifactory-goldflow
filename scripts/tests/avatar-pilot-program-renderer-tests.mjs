import assert from 'node:assert/strict';
import { parseLoudnormReport } from '../lib/avatar-pilot-program-renderer.mjs';

assert.deepEqual(parseLoudnormReport('ffmpeg filter\n{\n"input_i": "-16.2",\n"input_tp": "-1.8"\n}\nsize=900kB time=00:01:30\n'), { input_i: '-16.2', input_tp: '-1.8' });
assert.throws(() => parseLoudnormReport('no report'), /Missing loudnorm/);
assert.throws(() => parseLoudnormReport('{incomplete'), /Missing loudnorm/);
console.log('Program renderer loudnorm parsing regression passed; no rendering or media mutation.');
