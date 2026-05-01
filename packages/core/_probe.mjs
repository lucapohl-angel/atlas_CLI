import { BUILTIN_CHECKLISTS } from './dist/builtins/checklists.js';
import { parse } from 'yaml';
const c = BUILTIN_CHECKLISTS.find(x => x.relPath.includes('design-system'));
console.log('content length:', c.content.length);
try { const v = parse(c.content); console.log('parsed ok, keys:', Object.keys(v)); }
catch (e) { console.log('YAML err:', e.message); console.log('---begin---'); console.log(c.content); console.log('---end---'); }
