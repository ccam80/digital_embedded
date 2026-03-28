T5 ADC input
Vs    vs_pos  0  SIN(0 5 50)
R1    vs_pos  adc_in  1k
Vref  vref  0  DC 5
.tran 100u 40m
.meas tran v_vref    FIND v(vref)   AT=20m
.meas tran v_adc_pk  MAX  v(vs_pos)
.meas tran v_adc_in_pk MAX v(adc_in)
.end
