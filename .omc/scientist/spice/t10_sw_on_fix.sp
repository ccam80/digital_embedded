T10 analog switch ON corrected
Vs   vs_pos  0  DC 5
Rsw  vs_pos  probe  0.01
R1   probe   0  1k
.tran 1u 1u
.meas tran v_vs    FIND v(vs_pos) AT=1u
.meas tran v_probe FIND v(probe)  AT=1u
.end
