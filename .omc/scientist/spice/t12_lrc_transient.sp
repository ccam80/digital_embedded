T12 LRC switching transient
* Vs=5V, L=1mH, R1=1k (NO), R2=1k+C=1uF (NC)
* Model: step switch from R1 to R2+C path at t=1ms (FF toggles)
Vs   vcc  0  DC 5
L1   vcc  sw_com  1m  IC=0
* Initially connected to NO (R1):
* At t=1ms, switch commutates to NC (R2+C)
* Use two phases: 0->1ms through R1, then 1ms->5ms through R2+C
* Model with a voltage-controlled switch
SW1  sw_com  no_node  ctrl  0  SWMOD
R1   no_node  0  1k
SW2  sw_com  nc_node  ctrl2  0  SWMOD
R2   nc_node  cap_nc  1k
C1   cap_nc   0  1u  IC=0
Vctrl  ctrl  0  PULSE(0 1 0 1n 1n 2m 4m)
Vctrl2 ctrl2 0  PULSE(1 0 0 1n 1n 2m 4m)
.model SWMOD SW (RON=0.01 ROFF=1e9 VT=0.5 VH=0.1)
.tran 2u 8m
.meas tran v_no_pk MAX  v(no_node)
.meas tran v_no_ss FIND v(no_node) AT=0.5m
.meas tran v_nc_pk MAX  v(cap_nc)
.meas tran v_nc_ss FIND v(cap_nc)  AT=7m
.meas tran i_inductor_ss FIND i(L1) AT=0.5m
.end
