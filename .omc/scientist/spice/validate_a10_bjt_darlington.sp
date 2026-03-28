* a10: BJT Darlington pair (Vcc=12V)
.model QNPN NPN(IS=1e-14 BF=100 VAF=100)
Vcc   vcc   0      DC 12
Vin   vin   0      DC 1
Rb    vin   vbase  100000
Rc    vcc   vcoll  4700
Re    vemit 0      1000
Q2    vcoll vbase  vmid   QNPN
Q1    vmid  vbase  vemit  QNPN
.op
.print DC V(vcoll) V(vbase) V(vmid) V(vemit)
.end
