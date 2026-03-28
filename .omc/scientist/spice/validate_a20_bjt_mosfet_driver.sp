* a20: BJT+MOSFET mixed driver (Vdd=12V)
.model QNPN NPN(IS=1e-14 BF=100 VAF=100)
.model MNMOS NMOS(VTO=1 KP=2e-3 LAMBDA=0.01)
Vdd  vdd  0    DC 12
Vin  vin  0    DC 1
Rb   vin  vb   100000
Rc   vdd  vc   4700
Rd   vdd  vd   1000
Q1   vc   vb   0     QNPN
M1   vd   vc   0     0  MNMOS
.op
.print DC V(vb) V(vc) V(vd)
.end
