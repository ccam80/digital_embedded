T8 DAC OpAmp ADC servo
* DAC code=5, Vref=5V, 4-bit: Vdac = 5/16*5 = 1.5625V
* OpAmp non-inverting with gain=2 (Rf=Rin=1k)
Vdac  dac_out  0  DC 1.5625
Vref2 vref2  0  DC 5
* Ideal OpAmp model: gain=1e6
Eamp  amp_out  0  VCVS dac_out  fb_node  1e6
Rf    amp_out  fb_node  1k
Rin   fb_node  0  1k
.tran 1u 1u
.meas tran v_dac    FIND v(dac_out)  AT=1u
.meas tran v_amp    FIND v(amp_out)  AT=1u
.meas tran v_vref2  FIND v(vref2)    AT=1u
.end
