T11 relay de-energized (And=0)
* NO contact open: analog path broken
Vs   vs_node  0  DC 5
R1   probe    0  1k
* relay contact open: probe node floats/GND via R1
.tran 1u 1u
.meas tran v_vs    FIND v(vs_node) AT=1u
.meas tran v_probe FIND v(probe)   AT=1u
.end
