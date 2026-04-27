"""Fix mosfet.test.ts - 0-based voltage arrays to 1-based.
MOSFET nodes: G=2, S=3, D=1, B=S=3
So voltage array needs size 4: [0]=ground, [1]=D, [2]=G, [3]=S
"""

with open('src/components/semiconductors/__tests__/mosfet.test.ts', 'r', encoding='utf-8') as f:
    content = f.read()

original = content
changes = 0

# ── 1. makeNmosAtVgs_Vds helper ───────────────────────────────────────────────
old = (
    '  // Drive to operating point: vG=vgs+vS, vD=vds+vS, vS=0\n'
    '  const voltages = new Float64Array(3);\n'
    '  voltages[0] = vds;  // V(node1=D) = Vds (source at 0)\n'
    '  voltages[1] = vgs;  // V(node2=G) = Vgs\n'
    '  voltages[2] = 0;    // V(node3=S) = 0\n'
    '\n'
    '  // Iterate to converge voltage limiting\n'
    '  for (let i = 0; i < 50; i++) {\n'
    '    elementWithPins.load(makeDcOpCtx(voltages, 3));\n'
    '    voltages[0] = vds;\n'
    '    voltages[1] = vgs;\n'
    '    voltages[2] = 0;\n'
    '  }'
)
new = (
    '  // Drive to operating point: vG=vgs+vS, vD=vds+vS, vS=0\n'
    '  // 1-based: [0]=ground, [1]=nodeD, [2]=nodeG, [3]=nodeS\n'
    '  const voltages = new Float64Array(4);\n'
    '  voltages[1] = vds;  // V(node1=D) = Vds (source at 0)\n'
    '  voltages[2] = vgs;  // V(node2=G) = Vgs\n'
    '  voltages[3] = 0;    // V(node3=S) = 0\n'
    '\n'
    '  // Iterate to converge voltage limiting\n'
    '  for (let i = 0; i < 50; i++) {\n'
    '    elementWithPins.load(makeDcOpCtx(voltages, 4));\n'
    '    voltages[1] = vds;\n'
    '    voltages[2] = vgs;\n'
    '    voltages[3] = 0;\n'
    '  }'
)
if old in content:
    content = content.replace(old, new, 1)
    changes += 1
    print('makeNmosAtVgs_Vds: fixed')
else:
    print('MISS: makeNmosAtVgs_Vds')

# ── 2. cutoff_region ──────────────────────────────────────────────────────────
old = (
    '    const voltages = new Float64Array(3);\n'
    '    voltages[0] = 5;\n'
    '    voltages[1] = 0;\n'
    '    voltages[2] = 0;\n'
    '    const ctx = makeDcOpCtx(voltages, 3);\n'
    '    element.load(ctx);\n'
    '    const rhs = ctx.rhs;\n'
    '\n'
    '    // The Norton current at drain/source should be ≈ 0 (only GMIN leakage)\n'
    '    // All RHS stamps will be present but very small\n'
    '    for (let i = 0; i < rhs.length; i++) {\n'
    '      expect(Math.abs(rhs[i])).toBeLessThan(1e-10);\n'
    '    }'
)
new = (
    '    // 1-based: [0]=ground, [1]=nodeD, [2]=nodeG, [3]=nodeS\n'
    '    const voltages = new Float64Array(4);\n'
    '    voltages[1] = 5;\n'
    '    voltages[2] = 0;\n'
    '    voltages[3] = 0;\n'
    '    const ctx = makeDcOpCtx(voltages, 4);\n'
    '    element.load(ctx);\n'
    '    const rhs = ctx.rhs;\n'
    '\n'
    '    // The Norton current at drain/source should be ~ 0 (only GMIN leakage)\n'
    '    // All RHS stamps will be present but very small\n'
    '    // Check indices 1..3 (1-based nodes; index 0 is ground sentinel)\n'
    '    for (let i = 1; i < rhs.length; i++) {\n'
    '      expect(Math.abs(rhs[i])).toBeLessThan(1e-10);\n'
    '    }'
)
if old in content:
    content = content.replace(old, new, 1)
    changes += 1
    print('cutoff_region: fixed')
else:
    print('MISS: cutoff_region')

# ── 3. stamp_nonlinear_has_conductance_entries ─────────────────────────────────
old = (
    '    const voltages = new Float64Array(3);\n'
    '    voltages[0] = 5;\n'
    '    voltages[1] = 3;\n'
    '    voltages[2] = 0;\n'
    '    const ctx = makeDcOpCtx(voltages, 3);\n'
    '    element.load(ctx);\n'
    '    const entries = ctx.solver.getCSCNonZeros();\n'
    '\n'
    '    expect(entries.length).toBeGreaterThan(0);\n'
    '\n'
    '    // At least one conductance stamp should be significantly nonzero\n'
    '    const nonzeroStamps = entries.filter((e) => Math.abs(e.value) > 1e-15);\n'
    '    expect(nonzeroStamps.length).toBeGreaterThan(0);'
)
new = (
    '    // 1-based: [0]=ground, [1]=nodeD, [2]=nodeG, [3]=nodeS\n'
    '    const voltages = new Float64Array(4);\n'
    '    voltages[1] = 5;\n'
    '    voltages[2] = 3;\n'
    '    voltages[3] = 0;\n'
    '    const ctx = makeDcOpCtx(voltages, 4);\n'
    '    element.load(ctx);\n'
    '    const entries = ctx.solver.getCSCNonZeros();\n'
    '\n'
    '    expect(entries.length).toBeGreaterThan(0);\n'
    '\n'
    '    // At least one conductance stamp should be significantly nonzero\n'
    '    const nonzeroStamps = entries.filter((e) => Math.abs(e.value) > 1e-15);\n'
    '    expect(nonzeroStamps.length).toBeGreaterThan(0);'
)
if old in content:
    content = content.replace(old, new, 1)
    changes += 1
    print('stamp_nonlinear: fixed')
else:
    print('MISS: stamp_nonlinear')

# ── 4. srcFact_zero test - two voltages [0] arrays ────────────────────────────
old = (
    '    const voltages = new Float64Array(3);\n'
    '    voltages[0] = 5;\n'
    '    voltages[1] = 3;\n'
    '    voltages[2] = 0;\n'
    '\n'
    '    const ctxBaseline = makeDcOpCtx(voltages, 3);\n'
    '    ctxBaseline.srcFact = 1;\n'
    '    baseline.load(ctxBaseline);\n'
    '\n'
    '    const ctxZero = makeDcOpCtx(voltages, 3);\n'
    '    ctxZero.srcFact = 0;\n'
    '    zeroed.load(ctxZero);'
)
new = (
    '    // 1-based: [0]=ground, [1]=nodeD, [2]=nodeG, [3]=nodeS\n'
    '    const voltages = new Float64Array(4);\n'
    '    voltages[1] = 5;\n'
    '    voltages[2] = 3;\n'
    '    voltages[3] = 0;\n'
    '\n'
    '    const ctxBaseline = makeDcOpCtx(voltages, 4);\n'
    '    ctxBaseline.srcFact = 1;\n'
    '    baseline.load(ctxBaseline);\n'
    '\n'
    '    const ctxZero = makeDcOpCtx(voltages, 4);\n'
    '    ctxZero.srcFact = 0;\n'
    '    zeroed.load(ctxZero);'
)
if old in content:
    content = content.replace(old, new, 1)
    changes += 1
    print('srcFact_zero: fixed')
else:
    print('MISS: srcFact_zero')

print(f'\nTotal changes: {changes}')
if content == original:
    print('WARNING: no changes made')

with open('src/components/semiconductors/__tests__/mosfet.test.ts', 'w', encoding='utf-8') as f:
    f.write(content)
print('Written.')
