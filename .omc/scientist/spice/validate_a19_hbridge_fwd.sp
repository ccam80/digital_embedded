* a19: MOSFET H-bridge forward (Vdd=12V)
.model MNMOS NMOS(VTO=1 KP=2e-3 LAMBDA=0.01)
.model MPMOS PMOS(VTO=-1 KP=1e-3 LAMBDA=0.01)
Vdd  vdd  0    DC 12
Vfwd vfwd 0    DC 0
Vrev vrev 0    DC 12
Mp1  va   vfwd vdd  vdd  MPMOS
Mp2  vb   vrev vdd  vdd  MPMOS
Mn1  va   vfwd 0    0    MNMOS
Mn2  vb   vrev 0    0    MNMOS
Rload va  vb   100
.op
.print DC V(va) V(vb)
.end
