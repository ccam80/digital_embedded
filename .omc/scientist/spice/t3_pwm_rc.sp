T3 PWM to RC filter 50 pct duty
Vpwm  pwm_out  0  PULSE(0 5 0 1n 1n 500u 1m)
R1    pwm_out  cap_node  1k
C1    cap_node  0  1u  IC=0
.tran 10u 100m uic
.meas tran v_cap_ss FIND v(cap_node) AT=80m
.meas tran v_cap_end FIND v(cap_node) AT=100m
.end
