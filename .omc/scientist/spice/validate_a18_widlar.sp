* a18: Widlar current source (Vcc=12V)
.model QNPN NPN(IS=1e-14 BF=100 VAF=100)
Vcc   vcc  0    DC 12
Rref  vcc  vref 10000
Rload vcc  vout 47000
Re    ve2  0    5600
Q1    vref vref 0    QNPN
Q2    vout vref ve2  QNPN
.op
.print DC V(vref) V(vout) V(ve2)
.end
