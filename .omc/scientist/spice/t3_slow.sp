T3 PWM RC slow PWM
Vpwm  pwm_out  0  PULSE(0 5 0 1n 1n 5m 10m)
R1    pwm_out  cap_node  1k
C1    cap_node  0  1u  IC=0
.tran 100u 500m uic
.meas tran v_cap_mean AVG v(cap_node) FROM=400m TO=500m
.meas tran v_cap_max  MAX v(cap_node) FROM=400m TO=500m
.meas tran v_cap_min  MIN v(cap_node) FROM=400m TO=500m
.end
