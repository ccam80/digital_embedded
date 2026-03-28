* a9: BJT differential pair (Vcc=12V, balanced)
.model QNPN NPN(IS=1e-14 BF=100 VAF=100)
Vcc   vcc   0      DC 12
Vin1  vin1  0      DC 1
Vin2  vin2  0      DC 1
Rc1   vcc   vcol1  4700
Rc2   vcc   vcol2  4700
Rb1   vin1  vb1    100000
Rb2   vin2  vb2    100000
Re    vtail 0      5600
Q1    vcol1 vb1    vtail  QNPN
Q2    vcol2 vb2    vtail  QNPN
.op
.print DC V(vcol1) V(vcol2) V(vtail)
.end
