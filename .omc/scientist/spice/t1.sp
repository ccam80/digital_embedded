T1 DAC+RC
Vdac  dac_out  0  DC 3.125
R1    dac_out  cap_node  1k
C1    cap_node  0  1u  IC=0
.tran 10u 10m uic
.meas tran v_dac         FIND v(dac_out)  AT=10m
.meas tran v_cap_at_5tau FIND v(cap_node) AT=5m
.meas tran v_cap_final   FIND v(cap_node) AT=10m
.end
