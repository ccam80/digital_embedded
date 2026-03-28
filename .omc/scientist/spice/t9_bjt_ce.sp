T9 BJT common emitter
* Vcc=5V (default DcVoltageSource), Rb=1k, Rc=1k
* NPN BJT, base driven via Rb from Vcc (always ON)
Vcc  vcc  0  DC 5
Rb   vcc  base  1k
Rc   vcc  coll  1k
Q1   coll base  0  NPN_BJT
.model NPN_BJT NPN (BF=100 IS=1e-14 VAF=100)
.tran 1u 1u
.meas tran v_vcc    FIND v(vcc)   AT=1u
.meas tran v_base   FIND v(base)  AT=1u
.meas tran v_coll   FIND v(coll)  AT=1u
.end
