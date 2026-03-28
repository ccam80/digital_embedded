T10 analog switch OFF
* CTRL=0, switch open, R1=1k, Vs=5V
* Switch open -> no current -> probe node pulled to GND through R1
Vs   vs_node  0  DC 5
R1   probe    0  1k
* switch is open: probe not connected to Vs
.tran 1u 1u
.meas tran v_vs    FIND v(vs_node) AT=1u
.meas tran v_probe FIND v(probe)   AT=1u
.end
