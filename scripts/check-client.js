const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const htmlPath = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
  .filter(([, attributes, source]) => !/\bsrc\s*=/.test(attributes) && source.trim());

if (inlineScripts.length === 0) {
  throw new Error('No inline client scripts were found to validate.');
}

inlineScripts.forEach(([, , source], index) => {
  new vm.Script(source, { filename: `index.html:inline-script-${index + 1}` });
});

console.log(`Validated ${inlineScripts.length} inline client script(s).`);
