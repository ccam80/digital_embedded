* a21: 3-stage BJT amplifier (Vcc=12V)
.model QNPN NPN(IS=1e-14 BF=100 VAF=100)
Vcc vcc 0    DC 12
Vin vin 0    DC 1
Rb1 vin  vb1 100000
Rc1 vcc  vc1 4700
Re1 ve1  0   1000
Q1  vc1  vb1 ve1 QNPN
Rb2 vc1  vb2 100000
Rc2 vcc  vc2 4700
Re2 ve2  0   1000
Q2  vc2  vb2 ve2 QNPN
Rb3 vc2  vb3 100000
Rc3 vcc  vc3 4700
Re3 ve3  0   1000
Q3  vc3  vb3 ve3 QNPN
.op
.print DC V(vc1) V(vc2) V(vc3)
.end
