// Compare Java Digital vs TS pin transforms across all rotation+mirror combos
// Updated: TS now mirrors Y (not X) in local space, then rotates, then translates.

function javaTransform(lx, ly, posX, posY, rot, mirror) {
  const mats = {
    0: {cos:1,  sin:0},
    1: {cos:0,  sin:1},
    2: {cos:-1, sin:0},
    3: {cos:0,  sin:-1},
  };
  const {cos, sin} = mats[rot];

  if (!mirror) {
    return {
      x: lx * cos + ly * sin + posX,
      y: -lx * sin + ly * cos + posY,
    };
  }

  const m1 = {a:1, b:0, c:0, d:-1, x:0, y:0};
  const m2 = {a:cos, b:sin, c:-sin, d:cos, x:posX, y:posY};
  const mc = {
    a: m1.a*m2.a + m1.c*m2.b,
    b: m1.b*m2.a + m1.d*m2.b,
    c: m1.a*m2.c + m1.c*m2.d,
    d: m1.b*m2.c + m1.d*m2.d,
    x: m2.a*m1.x + m2.b*m1.y + m2.x,
    y: m2.c*m1.x + m2.d*m1.y + m2.y,
  };
  return {
    x: lx * mc.a + ly * mc.b + mc.x,
    y: lx * mc.c + ly * mc.d + mc.y,
  };
}

// TS pinWorldPosition: mirror Y in local, then rotate, then translate
function tsTransform(lx, ly, posX, posY, rot, mirror) {
  function rotatePoint(px, py, r) {
    switch(r) {
      case 0: return {x: px, y: py};
      case 1: return {x: py||0, y: (-px)||0};
      case 2: return {x: (-px)||0, y: (-py)||0};
      case 3: return {x: (-py)||0, y: px||0};
    }
  }
  let px = lx, py = ly;
  if (mirror) { py = -py; }
  const r = rotatePoint(px, py, rot);
  return {x: posX + r.x, y: posY + r.y};
}

const pins = [
  {lx: 1, ly: 0, label: "(1,0)"},
  {lx: -1, ly: 0, label: "(-1,0)"},
  {lx: 0, ly: 1, label: "(0,1)"},
  {lx: 0, ly: -1, label: "(0,-1)"},
];

let allOk = true;
for (const pin of pins) {
  console.log("Pin at local " + pin.label + ":");
  for (const rot of [0,1,2,3]) {
    for (const mir of [false, true]) {
      const j = javaTransform(pin.lx, pin.ly, 10, 10, rot, mir);
      const t = tsTransform(pin.lx, pin.ly, 10, 10, rot, mir);
      const ok = j.x === t.x && j.y === t.y;
      if (!ok) {
        allOk = false;
        console.log("  MISMATCH rot=" + rot + " mir=" + mir +
          " java=(" + j.x + "," + j.y + ") ts=(" + t.x + "," + t.y + ")");
      }
    }
  }
}
console.log(allOk ? "\nAll 32 cases match!" : "\nSome mismatches found.");
