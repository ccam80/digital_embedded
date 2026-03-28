T2 AND gate LOW driving 1k
Vgate  gate  0  DC 0
R1     gate  0  1k
.tran 1u 1u
.meas tran v_probe FIND v(gate) AT=1u
.end
