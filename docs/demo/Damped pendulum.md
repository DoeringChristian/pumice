A pendulum that loses energy to friction swings with a slowly shrinking amplitude. For small angles the motion follows @eq-motion, with damping $\gamma$ and natural frequency $\omega_0 = \sqrt{g/\ell}$ [@strogatz2015; @nelson1986].

$$
\ddot\theta + 2\gamma\,\dot\theta + \omega_0^2 \sin\theta = 0
$$
{#eq-motion}

## Measurement

The angle was recorded for 20 s with the [[Notes/Setup|setup]] shown in @fig-setup. The envelope in @fig-decay decays as $e^{-\gamma t}$, and the trajectory spirals into the origin of the phase plane.

![[figures/decay.svg|Angle over time, with the fitted envelope|50%]]{#fig-decay} ![[Setup.excalidraw|The setup|33%]]{#fig-setup}

> [!tip] Reading the fit
> Half the amplitude is lost after $t_{1/2} = \ln 2 / \gamma$, about 4.3 s for the longest string.

Table: Fitted damping for three string lengths {#tab-fit}

| Length (m) | ω₀ (rad/s) | γ (1/s) |
| ---------- | ---------- | ------- |
| 0.50       | 4.43       | 0.21    |
| 1.00       | 3.13       | 0.18    |
| 2.00       | 2.21       | 0.16    |

## Next steps

- [x] Repeat with the heavier bob
- [ ] Compare @tab-fit with the model in [[Notes/Air drag]]
- [ ] Add the phase portrait to the report
