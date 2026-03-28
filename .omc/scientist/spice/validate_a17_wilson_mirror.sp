* a17: Wilson current mirror (Vcc=12V)
.model QNPN NPN(IS=1e-14 BF=100 VAF=100)
Vcc   vcc   0     DC 12
Rref  vcc   vq1c  10000
Rload vcc   vq2c  10000
Q3    vq2c  vq1c  vbase  QNPN
Q1    vq1c  vbase 0      QNPN
Q2    vq2c  vbase 0      QNPN
.op
.print DC V(vq1c) V(vq2c) V(vbase)
.end
