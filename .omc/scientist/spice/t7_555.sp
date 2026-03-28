T7 555 astable timer
* Ra=1k, Rb=2k, C=1uF, Vcc=5V
* Approximate 555 with behavioral model using comparators and flip-flop
* Simplified: model capacitor charging/discharging
Vcc  vcc  0  DC 5
Ra   vcc  dis  1k
Rb   dis  cap  2k
C1   cap  0  1u  IC=1.667
* SR flip-flop behavior approximated: comparator thresholds at Vcc/3 and 2Vcc/3
* Use PWL source to approximate 555 output
* Analytical: f=288Hz, Thigh=2.079ms, Tlow=1.386ms
* For SPICE verification just model the RC charge/discharge
.tran 10u 20m
.meas tran v_cap_min  MIN v(cap)
.meas tran v_cap_max  MAX v(cap)
.meas tran v_vcc      FIND v(vcc) AT=10m
.end
