const fs = require("fs");
const path = require("path");

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name === "i18n") continue;
      walk(p, out);
    } else if (/\.(tsx|ts)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const files = walk("src/renderer");
const used = new Map(); // key -> [files]
const re = /\bt\(\s*(["'`])((?:(?!\1).)+)\1/g;
for (const f of files) {
  const content = fs.readFileSync(f, "utf8");
  let m;
  while ((m = re.exec(content))) {
    const key = m[2];
    if (!used.has(key)) used.set(key, []);
    used.get(key).push(f);
  }
}

function flatten(obj, prefix = "", out = {}) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const key = prefix ? prefix + "." + k : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      flatten(v, key, out);
    } else {
      out[key] = v;
    }
  }
  return out;
}

const en = flatten(JSON.parse(fs.readFileSync("src/renderer/i18n/locales/en.json", "utf8")));
const ja = flatten(JSON.parse(fs.readFileSync("src/renderer/i18n/locales/ja.json", "utf8")));

const usedKeys = [...used.keys()];
const hasTranslation = (catalog, key) => {
  if (key.includes("${")) return true;
  return key in catalog || `${key}_one` in catalog || `${key}_other` in catalog;
};
const missingEn = usedKeys.filter(k => !hasTranslation(en, k)).sort();
const missingJa = usedKeys.filter(k => !hasTranslation(ja, k)).sort();

console.log("files scanned:", files.length);
console.log("total distinct t() keys referenced:", usedKeys.length);
console.log("keys present in en.json:", Object.keys(en).length);
console.log("keys present in ja.json:", Object.keys(ja).length);
console.log("MISSING from en.json:", missingEn.length);
console.log("MISSING from ja.json:", missingJa.length);
console.log("--- missing keys grouped by file (first offender each) ---");
const byFile = {};
for (const k of missingEn) {
  const f = used.get(k)[0];
  byFile[f] = (byFile[f] || 0) + 1;
}
for (const [f, c] of Object.entries(byFile).sort((a,b)=>b[1]-a[1])) {
  console.log(c, f);
}
fs.writeFileSync("scratchpad-missing-keys.json", JSON.stringify(
  missingEn.map(k => ({ key: k, files: used.get(k) })), null, 2));
console.log("\nWrote full missing-key list to scratchpad-missing-keys.json");
