const fs = require("fs");
const xml = fs.readFileSync("fixtures/Sim/TC.dig", "utf-8");
const re = /<visualElement>\s*<elementName>(In|Out)<\/elementName>([\s\S]*?)<pos x="(-?\d+)" y="(-?\d+)"\/>/g;
let m;
while ((m = re.exec(xml)) !== null) {
  const type = m[1];
  const attrs = m[2];
  const lm = attrs.match(/<string>Label<\/string>\s*<string>([^<]*)<\/string>/);
  const label = lm ? lm[1] : "";
  console.log(type + " " + label + " grid=(" + parseInt(m[3])/20 + "," + parseInt(m[4])/20 + ")");
}
