* a8: BJT common-emitter (Vcc=12V)
.model QNPN NPN(IS=1e-14 BF=100 VAF=100)
Vcc   vcc   0      DC 12
Rb    vcc   vbase  100000
Rc    vcc   vcoll  4700
Re    vemit 0      1000
Q1    vcoll vbase  vemit  QNPN
.op
.print DC V(vcoll) V(vbase) V(vemit)
.end
