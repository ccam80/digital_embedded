* a15: JFET amplifier (Vdd=15V)
.model JFET1 NJF(VTO=-2 BETA=1.3e-3 LAMBDA=0.01)
Vdd   vdd   0      DC 15
Rd    vdd   vdrain 2200
Rs    vsrc  0      680
Rg    0     vgate  1000000
J1    vdrain vgate vsrc  JFET1
.op
.print DC V(vdrain) V(vgate) V(vsrc)
.end
