import { loadRuntimeConfig, validateConfig } from '../src/config/runtime-config';

const config = loadRuntimeConfig();
const errors = validateConfig(config);
console.log(`knob terbaca: ${Object.keys(config).length}`);
console.log(errors.length ? `ERROR:\n - ${errors.join('\n - ')}` : 'config valid, 0 error');
