import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import math, os

WORKDIR = "C:/local_working_projects/digital_in_browser/.omc/scientist"
os.makedirs(f"{WORKDIR}/figures", exist_ok=True)

fig, axes = plt.subplots(2, 3, figsize=(15, 9))
fig.suptitle("Analog Circuit SPICE Analysis — Tests 30-35", fontsize=13, fontweight="bold")

# --- Panel 1: Op-amp inverting ---
ax = axes[0, 0]
vin = np.linspace(-1.5, 1.5, 200)
vout = np.clip(-10 * vin, -15, 15)
ax.plot(vin, vout, "b-", linewidth=2, label="Vout = -10*Vin")
ax.plot(1.0, -9.99989, "r*", markersize=12, label="SPICE: Vin=1V, Vout=-9.999V")
ax.axhline(-9.99989, color="gray", linestyle="--", alpha=0.5)
ax.set_xlabel("Vin (V)"); ax.set_ylabel("Vout (V)")
ax.set_title("Test 30: Op-amp Inverting\nGain = -Rf/Rin = -10k/1k = -10")
ax.legend(fontsize=7); ax.grid(True, alpha=0.3)

# --- Panel 2: Op-amp integrator ---
ax = axes[0, 1]
t_int = np.linspace(0, 10e-3, 300)
slew = -100.0
vout_int = slew * t_int
ax.plot(t_int*1000, vout_int, "b-", linewidth=2, label="V(out) = -100*t  [V/s]")
ax.plot([1.0, 10.0], [-0.1, -1.0], "r*", markersize=10, label="SPICE checkpoints")
ax.set_xlabel("Time (ms)"); ax.set_ylabel("Vout (V)")
ax.set_title("Test 31: Op-amp Integrator\nSlew = -Vin/(R*C) = -1/(10k*1uF) = -100 V/s")
ax.legend(fontsize=7); ax.grid(True, alpha=0.3)
ax.annotate("slope = -100 V/s", xy=(5, -0.5), fontsize=8, color="blue")

# --- Panel 3: 555 astable ---
ax = axes[0, 2]
Ra, Rb, C_555, Vcc = 1000, 10000, 1e-6, 5.0
f_555 = 1.44 / ((Ra + 2*Rb) * C_555)
t_h = (Ra + Rb) * C_555 * math.log(2)
t_l = Rb * C_555 * math.log(2)
T_555 = t_h + t_l

t_cycle = np.linspace(0, 3 * T_555, 1200)
vout_555 = np.zeros_like(t_cycle)
vcap_555 = np.zeros_like(t_cycle)
state = "charge"; t0 = 0.0; v_init = Vcc / 3
for i, t in enumerate(t_cycle):
    dt = t - t0
    if state == "charge":
        v = Vcc - (Vcc - v_init) * np.exp(-dt / ((Ra + Rb) * C_555))
        if v >= 2/3 * Vcc:
            state = "discharge"; t0 = t; v_init = 2/3 * Vcc
        vout_555[i] = Vcc; vcap_555[i] = v
    else:
        v = v_init * np.exp(-dt / (Rb * C_555))
        if v <= 1/3 * Vcc:
            state = "charge"; t0 = t; v_init = 1/3 * Vcc
        vout_555[i] = 0; vcap_555[i] = v

ax.plot(t_cycle*1000, vcap_555, "b-", linewidth=2, label="V(cap)")
ax.plot(t_cycle*1000, vout_555, "r-", linewidth=2, label="V(out)")
ax.axhline(2/3*Vcc, color="green", linestyle="--", alpha=0.6, label=f"2/3 Vcc={2/3*Vcc:.2f}V")
ax.axhline(1/3*Vcc, color="orange", linestyle="--", alpha=0.6, label=f"1/3 Vcc={1/3*Vcc:.2f}V")
ax.set_xlabel("Time (ms)"); ax.set_ylabel("Voltage (V)")
ax.set_title(f"Test 32: 555 Astable\nf={f_555:.1f} Hz, T={T_555*1000:.2f} ms, duty={t_h/T_555*100:.0f}%")
ax.legend(fontsize=7); ax.grid(True, alpha=0.3)

# --- Panel 4: SCR latch states ---
ax = axes[1, 0]
states = ["OFF\n(before trigger)", "ON\n(latched)"]
va_states = [11.988, 1.217]
colors = ["#cc3333", "#22aa55"]
bars = ax.bar(states, va_states, color=colors, width=0.4, edgecolor="black")
ax.axhline(12, color="gray", linestyle="--", alpha=0.5, label="Vcc=12V")
for bar, val in zip(bars, va_states):
    ax.text(bar.get_x()+bar.get_width()/2, val+0.3, f"{val:.3f}V",
            ha="center", fontweight="bold", fontsize=10)
ax.set_ylabel("V(anode) [V]"); ax.set_title("Test 33: SCR Latch\nAnode voltage before/after trigger\n(Vcc=12V, R1=1k)")
ax.set_ylim(0, 14); ax.legend(fontsize=7); ax.grid(True, axis="y", alpha=0.3)
ax.text(0, 6, "SCR OFF\n~12V across it", ha="center", color="white", fontweight="bold", fontsize=8)
ax.text(1, 0.15, "SCR ON\nVTM~1.2V", ha="center", color="white", fontweight="bold", fontsize=8)

# --- Panel 5: Triac dimmer ---
ax = axes[1, 1]
t_ac = np.linspace(0, 2/60, 1000)
vs_wave = 170 * np.sin(2*math.pi*60*t_ac)
alpha_rad = math.radians(47.2)
vload_wave = np.zeros_like(vs_wave)
for i, t in enumerate(t_ac):
    phase = (2*math.pi*60*t) % (2*math.pi)
    if alpha_rad <= phase < math.pi:
        vload_wave[i] = vs_wave[i]
    elif math.pi + alpha_rad <= phase < 2*math.pi:
        vload_wave[i] = vs_wave[i]

Vrms = 170/math.sqrt(2) * math.sqrt((math.pi - alpha_rad + math.sin(2*alpha_rad)/2) / math.pi)
ax.plot(t_ac*1000, vs_wave, "gray", linestyle="--", alpha=0.5, label="Vs (170Vpk)")
ax.plot(t_ac*1000, vload_wave, "b-", linewidth=2, label=f"V(load) phase-cut")
ax.axhline(0, color="black", linewidth=0.5)
ax.set_xlabel("Time (ms)"); ax.set_ylabel("Voltage (V)")
ax.set_title(f"Test 34: Triac Dimmer\nFiring angle=47.2 deg, Vrms(load)={Vrms:.1f}V")
ax.legend(fontsize=7); ax.grid(True, alpha=0.3)

# --- Panel 6: LDR divider ---
ax = axes[1, 2]
lux_range = np.logspace(1.5, 4, 200)
R_ldr_range = 10000 * (lux_range / 100) ** (-0.7)
Vout_range = 5.0 * R_ldr_range / (10000 + R_ldr_range)
ax.semilogx(lux_range, Vout_range, "b-", linewidth=2)
ax.axvline(500, color="red", linestyle="--", alpha=0.7, label="Default: 500 lux")
ax.plot(500, 1.224, "r*", markersize=12, label="SPICE: 1.224V")
ax.set_xlabel("Illuminance (lux)"); ax.set_ylabel("V_out (V)")
ax.set_title("Test 35: LDR Voltage Divider\nVs=5V, R1=10k, R_ldr ~ lux^(-0.7)")
ax.legend(fontsize=7); ax.grid(True, alpha=0.3)
ax.set_xlim(30, 10000); ax.set_ylim(0, 5.5)
ax.text(500, 1.5, "1.224V", color="red", fontsize=9, ha="center")

plt.tight_layout()
out = f"{WORKDIR}/figures/analog_tests_30-35_spice_analysis.png"
plt.savefig(out, dpi=120, bbox_inches="tight")
plt.close()
print(f"Saved: {out}")
