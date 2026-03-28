* a16: Cascode amplifier (Vcc=12V)
.model QNPN NPN(IS=1e-14 BF=100 VAF=100)
Vcc   vcc    0      DC 12
Vin   vin    0      DC 1
Vbias vbias  0      DC 6
Rc    vcc    vc2    4700
Rb    vin    vb1    100000
Re    ve1    0      1000
Q2    vc2    vbias  vmid   QNPN
Q1    vmid   vb1    ve1    QNPN
.op
.print DC V(vc2) V(vmid) V(vb1) V(ve1)
.end
