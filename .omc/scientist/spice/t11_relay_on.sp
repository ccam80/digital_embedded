T11 relay energized (And=1)
* NO contact closed: Vs -> relay -> R1 -> GND
Vs   vs_node  0  DC 5
Rrel vs_node  probe  0.1
R1   probe    0      1k
.tran 1u 1u
.meas tran v_vs    FIND v(vs_node) AT=1u
.meas tran v_probe FIND v(probe)   AT=1u
.end
