T10 analog switch ON
* CTRL=1, switch closed: Vs=5V -> R1=1k -> GND, probe = 5V
Vs   vs_node  sw_in  DC 5
Rsw  sw_in    probe  0.01
R1   probe    0      1k
.tran 1u 1u
.meas tran v_vs    FIND v(vs_node) AT=1u
.meas tran v_probe FIND v(probe)   AT=1u
.end
