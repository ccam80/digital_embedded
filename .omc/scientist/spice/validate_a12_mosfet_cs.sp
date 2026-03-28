* a12: MOSFET common-source (Vdd=12V)
.model MNMOS NMOS(VTO=1 KP=2e-3 LAMBDA=0.01)
Vdd   vdd   0      DC 12
Vg    vgate 0      DC 3
Rd    vdd   vdrain 4700
Rs    vsrc  0      1000
Rg    vgate vgs    1000000
M1    vdrain vgs   vsrc    0  MNMOS
.op
.print DC V(vdrain) V(vgs) V(vsrc)
.end
