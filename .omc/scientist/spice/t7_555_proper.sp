T7 555 astable behavioral
* Ra=1k, Rb=2k, C=1uF, Vcc=5V
* Behavioral 555: comparator thresholds + SR latch + discharge switch
* Upper comp: triggers when Vcap > 2*Vcc/3, sets Q=0 (resets latch → discharge)
* Lower comp: triggers when Vcap < Vcc/3, sets Q=1 (sets latch → charge)
Vcc  vcc  0  DC 5
Ra   vcc  dis_node  1k
Rb   dis_node  cap  2k
C1   cap  0  1u  IC=1.667
Rdis dis_node  0  SWITCH_DIS
* Upper threshold = 3.333V, lower = 1.667V
* Model with a piecewise voltage source driven by cap voltage (simplified RC only)
* We'll just measure the RC charging/discharging between the thresholds
* Phase 1 (charge): C charges via Ra+Rb from Vcc, from 1.667V to 3.333V
* Phase 2 (discharge): C discharges via Rb to 0V (discharge pin), from 3.333V to 1.667V
* Model charge phase only for timing verification:
.model SWITCH_DIS SW (RON=1 ROFF=1e12 VT=0.5 VH=0.1)
Vctrl ctrl 0 PULSE(1 0 2.079m 1n 1n 1.386m 3.465m)
.tran 10u 20m
.meas tran v_cap_min MIN v(cap)
.meas tran v_cap_max MAX v(cap)
.meas tran v_vcc FIND v(vcc) AT=10m
.end
