T6 Schmitt trigger input voltage
Vs    vs_pos  0  SIN(0 5 50)
R1    vs_pos  schmitt_in  1k
.tran 100u 100m
.meas tran v_schmitt_pk MAX v(schmitt_in)
.meas tran v_schmitt_min MIN v(schmitt_in)
.meas tran v_schmitt_at_20ms FIND v(schmitt_in) AT=20m
.end
