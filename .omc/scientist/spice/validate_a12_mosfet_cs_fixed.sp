* a12: MOSFET common-source corrected (Vdd=12V, Vg=3V)
.model MNMOS NMOS(VTO=1 KP=2e-3 LAMBDA=0.01)
Vdd   vdd   0      DC 12
Vg    vgate 0      DC 3
Rd    vdd   vdrain 4700
Rs    vsrc  0      1000
M1    vdrain vgate vsrc 0 MNMOS
.op
.print DC V(vdrain) V(vgate) V(vsrc)
.end
