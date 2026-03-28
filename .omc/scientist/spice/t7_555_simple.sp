T7 555 cap charge discharge
* Charge: C1 charges from Vcc/3=1.667V to 2*Vcc/3=3.333V via Ra+Rb=3k
* t_charge = (Ra+Rb)*C*ln(2) = 3000*1e-6*0.693 = 2.079ms
* Discharge: C1 discharges from 3.333V to 1.667V via Rb=2k
* t_discharge = Rb*C*ln(2) = 2000*1e-6*0.693 = 1.386ms
Vcc   vcc  0  DC 5
Ra    vcc  dis_sw  1k
Rb    dis_sw  cap  2k
C1    cap  0  1u  IC=1.667
* Discharge switch: closes to GND when cap reaches 3.333V (modeled with VCVS)
* For simple check: just charge from 1.667 to 3.333 with Ra+Rb=3k
Vdis  dis_sw  0  PULSE(5 0 2.079m 1n 1n 1.386m 3.465m)
.tran 5u 10m
.meas tran v_cap_min MIN v(cap)
.meas tran v_cap_max MAX v(cap)
.meas tran v_vcc     FIND v(vcc) AT=5m
.end
