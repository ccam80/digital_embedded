T4 Comparator pot divider
Vs     vcc  0  DC 5
Rpot_top  vcc  wiper  3k
Rpot_bot  wiper  0  7k
Vref   vref_node  0  DC 5
.tran 1u 1u
.meas tran v_wiper  FIND v(wiper)     AT=1u
.meas tran v_vref   FIND v(vref_node) AT=1u
.meas tran v_vcc    FIND v(vcc)       AT=1u
.end
