* a11: BJT push-pull emitter follower (Vcc=12V)
.model QNPN NPN(IS=1e-14 BF=100 VAF=100)
.model QPNP PNP(IS=1e-14 BF=100 VAF=100)
Vcc   vcc   0      DC 12
Vin   vin   0      DC 3
Q1    vcc   vin    vout   QNPN
Q2    0     vin    vout   QPNP
Rl    vout  0      1000
.op
.print DC V(vout) V(vin)
.end
