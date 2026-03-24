// Quick diagnostic: check what rotatePoint produces for Driver pins
// to verify resolvePins is rotating correctly

function rotatePoint(px, py, r) {
  switch(r) {
    case 0: return {x: px, y: py};
    case 1: return {x: py||0, y: (-px)||0};
    case 2: return {x: (-px)||0, y: (-py)||0};
    case 3: return {x: (-py)||0, y: px||0};
  }
}

console.log("Driver pin 'in' at local (-1, 0):");
for (let rot = 0; rot <= 3; rot++) {
  const r = rotatePoint(-1, 0, rot);
  console.log("  rot=" + rot + ": (" + r.x + ", " + r.y + ")");
}

console.log("\nDriver pin 'sel' at local (0, -1):");
for (let rot = 0; rot <= 3; rot++) {
  const r = rotatePoint(0, -1, rot);
  console.log("  rot=" + rot + ": (" + r.x + ", " + r.y + ")");
}

console.log("\nDriver pin 'out' at local (1, 0):");
for (let rot = 0; rot <= 3; rot++) {
  const r = rotatePoint(1, 0, rot);
  console.log("  rot=" + rot + ": (" + r.x + ", " + r.y + ")");
}

console.log("\nSplitter pin at local (0, 0) and (1, 0):");
for (let rot = 0; rot <= 3; rot++) {
  const r0 = rotatePoint(0, 0, rot);
  const r1 = rotatePoint(1, 0, rot);
  console.log("  rot=" + rot + ": (0,0)->(" + r0.x + "," + r0.y + ")  (1,0)->(" + r1.x + "," + r1.y + ")");
}

// Check the || 0 issue: (-0) || 0
console.log("\nEdge case: (-0) || 0 = " + ((-0) || 0));
console.log("-0 is falsy: " + (!(-0)));
console.log("rotatePoint(0, 1, 1) = " + JSON.stringify(rotatePoint(0, 1, 1)));
console.log("rotatePoint(1, 0, 2) = " + JSON.stringify(rotatePoint(1, 0, 2)));
