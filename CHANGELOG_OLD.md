# Older changes

### 0.1.1

- Select the ioBroker host address from the route to the coffee machine.
- Use the default callback port for new installations and retain custom ports on upgrade.
- Show the machine IP address field only when LAN is enabled.

### 0.1.0

- Use a single switch for LAN statistics and controls.
- Group manual drink buttons in `lan.control.drinks` and remove the separate Automation branch.
- Add PrimaDonna Soul recipe buttons for milk drinks, Doppio+ and other presets.
- Keep Cloud and LAN values separate and remove duplicate LAN diagnostics.

### 0.0.15

- Read PrimaDonna Soul statistics directly over LAN.
- Add optional controls with setting readback and retry transient LAN registration failures.
- Add package validation and an ioBroker installation and startup test.

